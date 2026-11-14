/**
 * Carries out a planned decision for one exchange: answer synthetically,
 * break the connection, or forward and then disturb the response.
 *
 * Planning (fault-planner.mjs) and execution are separate on purpose: the
 * planner is pure and unit-checkable, and this module is the only place that
 * touches sockets on a fault's behalf.
 */
import {
  drain_request,
  drop_after_flush,
  drop_connection,
  exchange_sleep,
  send_response,
} from './exchange.mjs';
import {
  build_error_response,
  extract_error_code,
  has_synthetic_response,
} from '../faults/graph-error-responses.mjs';
import { deliver_mutated, MUTATION_FAULTS } from '../faults/response-mutations.mjs';
import { deliver_reordered } from '../faults/response-reorder.mjs';
import { stream_unchanged } from '../faults/response-streaming.mjs';
import {
  deliver_slow_body,
  deliver_truncated,
  hold_without_response,
  lose_response,
  reset_connection,
} from '../faults/transport-faults.mjs';
import {
  client_response_headers,
  forward_request,
  read_upstream_body,
} from './upstream-forwarder.mjs';

/** Answers with the fault's synthetic Graph or Entra ID error, after reading the request. */
async function respond_synthetic(ex) {
  await drain_request(ex);
  if (
    ex.fault.id === 'gateway_timeout_504' &&
    !(await exchange_sleep(ex, ex.fault.params.delay_ms))
  )
    return;
  const response = build_error_response(ex.fault.id, {
    service: ex.service,
    params: ex.fault.params,
    origin: ex.origin,
    path: ex.path,
  });
  ex.graph_error = extract_error_code(response.body);
  send_response(ex, response.status, response.headers, response.body);
}

/** True when a response cannot carry a body, so body faults have nothing to act on. */
function has_no_body(ex, up_res) {
  return ex.req.method === 'HEAD' || up_res.statusCode === 204 || up_res.statusCode === 304;
}

/** Delivers a forwarded response, through the fault's disturbance when one applies. */
async function deliver_forwarded(ex, up_res, deps) {
  const body = read_upstream_body(ex, up_res);
  const id = ex.fault?.id;
  const headers = client_response_headers(up_res);
  if (id === 'lost_response') return lose_response(ex, body);
  if (id && id !== 'slow_first_byte' && id !== 'out_of_order' && has_no_body(ex, up_res)) {
    ex.fault.skipped = 'response has no body';
    return stream_unchanged(ex, up_res.statusCode, headers, body);
  }
  if (id === 'slow_body') return deliver_slow_body(ex, up_res, body);
  if (id === 'truncated_body') return deliver_truncated(ex, up_res, body);
  if (MUTATION_FAULTS.has(id)) return deliver_mutated(ex, up_res, body);
  if (id === 'out_of_order') return deliver_reordered(ex, up_res, body, deps.reorder_gate);
  return stream_unchanged(ex, up_res.statusCode, headers, body);
}

/**
 * Mirrors an upstream transport failure to the client: a reset when nothing
 * was sent yet, a dropped connection mid-body. A relay that answered 502
 * instead would hide exactly the transport behaviour being tested.
 */
function mirror_upstream_failure(ex) {
  if (ex.client_gone) return;
  const reason = `upstream ${ex.upstream?.error ?? 'failure'}, mirrored by relay`;
  if (ex.res.headersSent) drop_after_flush(ex, 'truncated', reason);
  else drop_connection(ex, 'reset', 'reset', reason);
}

/** Forwards the request (after slow_first_byte's delay) and delivers the response. */
async function forward_and_deliver(ex, deps) {
  if (ex.fault?.id === 'slow_first_byte' && !(await exchange_sleep(ex, ex.fault.params.delay_ms)))
    return;
  let up_res;
  try {
    up_res = await forward_request(ex, deps);
  } catch {
    return mirror_upstream_failure(ex);
  }
  try {
    await deliver_forwarded(ex, up_res, deps);
  } catch (error) {
    // An upstream read failure is the upstream's fault; anything else is a relay bug.
    if (!ex.upstream?.error && !ex.client_gone) throw error;
    mirror_upstream_failure(ex);
  }
}

/** Executes the exchange's planned fault (or a clean passthrough when there is none). */
export async function execute_exchange(ex, deps) {
  const id = ex.fault?.id;
  if (id === 'connection_reset') return reset_connection(ex);
  if (id === 'no_response') return hold_without_response(ex);
  if (id && has_synthetic_response(id)) return respond_synthetic(ex);
  return forward_and_deliver(ex, deps);
}
