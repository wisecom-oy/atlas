/**
 * What the report needs to know about each fault id, without importing the engine.
 *
 * The journal records a fault's id but not its category, and the report must keep working on a run
 * directory written by an older or newer engine. This fallback table supplies a category and the
 * effect the fault has on the client. A category written into the journal record wins over the
 * table, and an id found in neither is reported as `unknown` and judged only by what was delivered.
 *
 * Effects:
 *   error      a synthetic HTTP error status, the client sees a failed request
 *   transport  the connection fails or stalls, the client sees a network error
 *   lost       forwarded and committed upstream, then the client sees a network error
 *   corrupt    a 2xx whose body cannot be used (parse failure, empty body)
 *   altered    a usable 2xx whose content is subtly wrong (duplicates, missing nextLink, inner 429)
 *   delay      a correct response that arrives late or out of order
 */

const FALLBACK_CATALOG = {
  throttle_429: ['throttle', 'error'],
  throttle_429_no_retry_after: ['throttle', 'error'],
  throttle_429_long_retry_after: ['throttle', 'error'],
  throttle_503: ['throttle', 'error'],
  token_endpoint_429: ['throttle', 'error'],
  batch_inner_429: ['throttle', 'altered'],
  server_500: ['server', 'error'],
  bad_gateway_502: ['server', 'error'],
  unavailable_503: ['server', 'error'],
  gateway_timeout_504: ['server', 'error'],
  html_503: ['server', 'error'],
  mailbox_backend_503: ['server', 'error'],
  token_endpoint_503: ['server', 'error'],
  spurious_401: ['auth', 'error'],
  download_url_expired_401: ['auth', 'error'],
  spurious_400: ['consistency', 'error'],
  transient_404: ['consistency', 'error'],
  locked_423: ['consistency', 'error'],
  delta_resync_410: ['consistency', 'error'],
  delta_token_expired: ['consistency', 'error'],
  upload_session_gone_404: ['consistency', 'error'],
  upload_fragment_416: ['consistency', 'error'],
  duplicate_items: ['consistency', 'altered'],
  shuffle_items: ['consistency', 'altered'],
  connection_reset: ['transport', 'transport'],
  no_response: ['transport', 'transport'],
  truncated_body: ['transport', 'transport'],
  slow_first_byte: ['transport', 'delay'],
  slow_body: ['transport', 'delay'],
  lost_response: ['transport', 'lost'],
  malformed_json: ['content', 'corrupt'],
  empty_body_200: ['content', 'corrupt'],
  drop_next_link: ['content', 'altered'],
  out_of_order: ['ordering', 'delay'],
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Category of a fault id: the journal's own value first, then the fallback table, else `unknown`. */
export function fault_category(fault_id, recorded_category = null) {
  if (recorded_category) return recorded_category;
  return FALLBACK_CATALOG[fault_id]?.[0] ?? 'unknown';
}

/** Effect of a fault id on the client, or `unknown` for an id the table has never seen. */
export function fault_effect(fault_id) {
  return FALLBACK_CATALOG[fault_id]?.[1] ?? 'unknown';
}

/** True when the fault damages or alters the response content rather than its status or transport. */
export function is_content_fault(fault_id, category = null) {
  const effect = fault_effect(fault_id);
  if (effect === 'corrupt' || effect === 'altered') return true;
  return effect === 'unknown' && fault_category(fault_id, category) === 'content';
}

/** True for methods that change state upstream, where a repeated request can apply twice. */
export function is_write_method(method) {
  return !READ_METHODS.has(method);
}

/**
 * Classifies one attempt as the client experienced it: `failure`, `altered` or `clean`.
 *
 * A failure is anything the client cannot use: an incomplete exchange, a status of 400 or more, or
 * a 2xx whose body an applied fault made unusable. An applied fault that leaves a usable 2xx is
 * `altered`, which still ends a retry chain because the client got an answer it can act on. An
 * unknown fault id that delivered a complete 2xx is treated as altered, never as clean, so a fault
 * the report cannot name is still visible.
 */
export function classify_attempt(attempt) {
  if (attempt.outcome !== 'complete') return 'failure';
  if (attempt.status === null || attempt.status >= 400) return 'failure';
  if (!attempt.fault_id || attempt.fault_skipped) return 'clean';
  const effect = fault_effect(attempt.fault_id);
  if (effect === 'corrupt') return 'failure';
  if (effect === 'delay') return 'clean';
  return 'altered';
}
