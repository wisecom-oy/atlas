/**
 * Recognises a transport failure: the request never got an HTTP answer, or its body stopped
 * arriving. Classification reads error codes and error names only, never the message text, which
 * carries request ids, byte ranges and item ids that can contain any word or number (issue #618).
 */

/** Node socket and DNS codes, and undici's transport codes, for failures worth repeating. */
const NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/**
 * An aborted or timed-out transfer: a per-chunk or per-request timer firing, or the service
 * cutting the body off. A cancelled run is checked by every retry loop before it classifies, so
 * an abort that reaches this point is a transfer that can be tried again.
 */
const ABORT_ERROR_IDENTIFIERS = new Set(['AbortError', 'TimeoutError', 'ABORT_ERR']);

/**
 * The `code` the Graph SDK gives a native fetch rejection it wraps. The SDK copies the native
 * error's `name` into `code` and drops its `cause`, so this is all that survives of a
 * `TypeError: fetch failed` or a body that ended early. Fetch reports every network error as a
 * `TypeError`, and Graph's own error codes are never spelled that way.
 */
const SDK_WRAPPED_FETCH_FAILURE_CODE = 'TypeError';

/**
 * Returns true for network-level errors (socket timeout, DNS failure, connection reset, a transfer
 * aborted mid-body) that are worth retrying. Reads `code` and `name` on the error and on its
 * `cause` chain, where a raw `fetch` rejection keeps the socket error.
 */
export function is_network_error(err: unknown): boolean {
  return error_and_causes(err).some(is_network_failure);
}

/** One link of the chain, judged on its own `code` and `name`. */
function is_network_failure(link: Record<string, unknown>): boolean {
  const { code, name } = link;
  if (typeof code === 'string') {
    if (NETWORK_ERROR_CODES.has(code) || ABORT_ERROR_IDENTIFIERS.has(code)) return true;
    if (code === SDK_WRAPPED_FETCH_FAILURE_CODE) return true;
  }
  return typeof name === 'string' && ABORT_ERROR_IDENTIFIERS.has(name);
}

/** The error followed by its `cause` chain, objects only, stopping at a cycle. */
function error_and_causes(err: unknown): Record<string, unknown>[] {
  const links: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current = err;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const link = current as Record<string, unknown>;
    links.push(link);
    current = link.cause;
  }
  return links;
}
