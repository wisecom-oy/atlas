/**
 * What was requested: request shapes, per-service totals, status mixes and latency.
 *
 * Fed one attempt at a time in any order. Memory is proportional to the number of distinct
 * request shapes (method plus templated URL), never to the number of requests.
 */
import { classify_attempt } from './fault-knowledge.mjs';
import {
  add_to_histogram,
  bump,
  create_histogram,
  ranked_counts,
  summarise_histogram,
} from './number-summary.mjs';

/** True when a fault was planned and actually applied to this attempt. */
export function fault_applied(attempt) {
  return Boolean(attempt.fault_id) && !attempt.fault_skipped;
}

/** Status as the client received it, with the transport outcome when the exchange did not complete. */
export function delivered_status_key(attempt) {
  if (attempt.outcome === 'complete') return String(attempt.status ?? 'none');
  return attempt.status ? `${attempt.status}+${attempt.outcome}` : attempt.outcome;
}

/** What the real upstream answered, or why it was never asked. */
export function upstream_status_key(attempt) {
  if (!attempt.forwarded) return 'not forwarded';
  if (attempt.upstream_status) return String(attempt.upstream_status);
  if (attempt.upstream_error) return `error ${attempt.upstream_error}`;
  return 'no answer';
}

function create_shape(attempt) {
  return {
    method: attempt.method,
    url: attempt.url,
    service: attempt.service,
    kind: attempt.kind,
    count: 0,
    faulted: 0,
    failures: 0,
    delivered: new Map(),
    latency_clean: create_histogram(),
    latency_faulted: create_histogram(),
  };
}

function create_service() {
  return { requests: 0, faulted: 0, failures: 0, kinds: new Map() };
}

function shape_to_json(shape) {
  return {
    method: shape.method,
    url: shape.url,
    service: shape.service,
    kind: shape.kind,
    count: shape.count,
    faulted: shape.faulted,
    failures: shape.failures,
    delivered_mix: ranked_counts(shape.delivered),
    latency_unfaulted: summarise_histogram(shape.latency_clean),
    latency_faulted: summarise_histogram(shape.latency_faulted),
  };
}

/** Creates the accumulator for request shapes, services, status mixes and latency. */
export function create_traffic_aggregates() {
  const shapes = new Map();
  const services = new Map();
  const upstream_mix = new Map();
  const delivered_mix = new Map();
  const latency_clean = create_histogram();
  const latency_faulted = create_histogram();
  const totals = {
    requests: 0,
    req_bytes: 0,
    bytes: 0,
    min_t: null,
    max_end: null,
    max_total_ms: 0,
  };

  function add_totals(a) {
    totals.requests += 1;
    totals.req_bytes += a.req_bytes;
    totals.bytes += a.bytes;
    totals.min_t = totals.min_t === null ? a.t : Math.min(totals.min_t, a.t);
    totals.max_end = Math.max(totals.max_end ?? 0, a.t + a.total_ms);
    totals.max_total_ms = Math.max(totals.max_total_ms, a.total_ms);
  }

  function add(a) {
    const applied = fault_applied(a);
    const failed = classify_attempt(a) === 'failure';
    add_totals(a);
    let shape = shapes.get(a.shape_key);
    if (!shape) shapes.set(a.shape_key, (shape = create_shape(a)));
    shape.count += 1;
    shape.faulted += applied ? 1 : 0;
    shape.failures += failed ? 1 : 0;
    bump(shape.delivered, delivered_status_key(a));
    add_to_histogram(applied ? shape.latency_faulted : shape.latency_clean, a.total_ms);
    add_to_histogram(applied ? latency_faulted : latency_clean, a.total_ms);
    let service = services.get(a.service);
    if (!service) services.set(a.service, (service = create_service()));
    service.requests += 1;
    service.faulted += applied ? 1 : 0;
    service.failures += failed ? 1 : 0;
    bump(service.kinds, a.kind);
    bump(upstream_mix, upstream_status_key(a));
    bump(delivered_mix, delivered_status_key(a));
  }

  function finish() {
    return {
      totals: {
        ...totals,
        span_ms: totals.min_t === null ? 0 : totals.max_end - totals.min_t,
        distinct_shapes: shapes.size,
      },
      services: [...services.entries()]
        .map(([name, s]) => ({ service: name, ...s, kinds: ranked_counts(s.kinds) }))
        .sort((a, b) => b.requests - a.requests),
      upstream_mix: ranked_counts(upstream_mix),
      delivered_mix: ranked_counts(delivered_mix),
      latency: {
        unfaulted: summarise_histogram(latency_clean),
        faulted: summarise_histogram(latency_faulted),
      },
      shapes: [...shapes.values()].map(shape_to_json).sort((a, b) => b.count - a.count),
    };
  }

  return { add, finish };
}
