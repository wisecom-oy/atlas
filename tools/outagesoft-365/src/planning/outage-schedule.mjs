/**
 * Outage windows: a service fails every request for a stretch of time.
 *
 * Windows are timed from the first relayed request, not from process start,
 * so a slow `pnpm` startup or a build step before the first Graph call does
 * not eat into the window.
 *
 * An outage fault must be a synthetic response that applies to every request
 * of the service: a window where only delta requests fail is not an outage.
 * Entra ID is the exception that makes the rule bearable: an identity outage
 * with a Graph-shaped fault is mapped to the token endpoint's own wire shape,
 * because a token endpoint never answers with a Graph error body.
 */
import { parse_duration } from '../shared/duration.mjs';
import { get_fault } from '../faults/fault-catalog.mjs';
import { expand_service_selector } from '../request/m365-hosts.mjs';

const DEFAULT_OUTAGE_FAULT = 'unavailable_503';
const TRANSPORT_AS_IS = new Set(['connection_reset', 'no_response']);
const TOKEN_FAULTS = new Set(['token_endpoint_503', 'token_endpoint_429']);

/** Maps an outage fault to what an identity request receives during that outage. */
export function identity_outage_fault(fault_id) {
  if (TRANSPORT_AS_IS.has(fault_id) || TOKEN_FAULTS.has(fault_id)) return fault_id;
  return get_fault(fault_id)?.category === 'throttle' ? 'token_endpoint_429' : 'token_endpoint_503';
}

/** Throws unless `fault_id` can be the fault of an outage over `service`. */
export function validate_outage(outage) {
  const services = expand_service_selector(outage.service);
  if (!services) throw new Error(`unknown outage service '${outage.service}'`);
  const fault = get_fault(outage.fault);
  if (!fault) throw new Error(`unknown outage fault '${outage.fault}'`);
  if (fault.forwards) {
    throw new Error(
      `outage fault '${outage.fault}' forwards the request; an outage needs a synthetic fault`,
    );
  }
  if (fault.kinds || fault.methods) {
    throw new Error(
      `outage fault '${outage.fault}' only applies to some requests, so it cannot be an outage`,
    );
  }
  if (TOKEN_FAULTS.has(fault.id) && services.some((s) => s !== 'identity')) {
    throw new Error(
      `outage fault '${outage.fault}' is a token endpoint fault; use it with service identity`,
    );
  }
  const uncovered = services.filter((s) => s !== 'identity' && !fault.services.includes(s));
  if (uncovered.length) {
    throw new Error(
      `outage fault '${outage.fault}' does not apply to ${uncovered.join(', ')}; pick a narrower service`,
    );
  }
  if (!Number.isInteger(outage.start_ms) || outage.start_ms < 0)
    throw new Error('outage start must be >= 0');
  if (!Number.isInteger(outage.duration_ms) || outage.duration_ms <= 0) {
    throw new Error(`outage duration must be > 0 (got ${outage.duration_ms}ms)`);
  }
}

/** Parses one `--outage svc:start:dur[:fault]` value, e.g. `outlook:30s:2m:no_response`. */
export function parse_outage_spec(text) {
  const parts = String(text).split(':');
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(
      `invalid --outage '${text}': expected service:start:duration[:fault], e.g. outlook:30s:2m`,
    );
  }
  const [service, start, duration, fault = DEFAULT_OUTAGE_FAULT] = parts;
  let outage;
  try {
    outage = {
      service,
      start_ms: parse_duration(start),
      duration_ms: parse_duration(duration),
      fault,
    };
    validate_outage(outage);
  } catch (error) {
    throw new Error(`invalid --outage '${text}': ${error.message}`);
  }
  return outage;
}

/** Returns the first outage covering `service` at `elapsed_ms` since the first request, or null. */
export function active_outage(outages, elapsed_ms, service) {
  if (elapsed_ms === null || elapsed_ms === undefined) return null;
  for (const outage of outages) {
    const in_window =
      elapsed_ms >= outage.start_ms && elapsed_ms < outage.start_ms + outage.duration_ms;
    if (in_window && expand_service_selector(outage.service)?.includes(service)) return outage;
  }
  return null;
}
