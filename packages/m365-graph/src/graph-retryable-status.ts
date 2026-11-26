/**
 * Which Graph HTTP statuses the retry loop repeats, and which of them are Graph telling the whole
 * client to slow down. Decided from the numeric status only, never from message text (issue #618).
 */

/**
 * Statuses Graph recovers from on its own, per Microsoft's throttling and resilience guidance: the
 * request never reached a working backend, the gateway gave up on one, or the service shed load.
 *
 * - `408` is a timeout by definition, and the token path already treats it as transient (#867).
 * - `429` and `509` are throttles: Graph or SharePoint is over a request or bandwidth limit.
 * - `500`, `502`, `503`, `504` are load and gateway faults.
 *
 * Not retried, and why (issue #867):
 * - `423 Locked`: the item is locked, typically a checked-out or exclusively opened file. The
 *   lock is held by a person or an app and outlives a retry budget, so the item fails on its own.
 * - `507 Insufficient Storage`: the target is out of quota. Waiting does not free space.
 * - `501` and every other `4xx`: repeating the request returns the same answer.
 *   A `401` is the exception: it is repeated once with a new token (`NewTokenRepeat`, issue #861).
 *
 * These apply to idempotent calls only. A 5xx or a timeout after a create POST can arrive after
 * the backend committed it, so a call marked `idempotent: false` retries only on a throttle
 * response (see `is_throttle_response`, issue #624).
 */
const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504, 509]);

/**
 * Statuses that ask the whole client to back off, not only the one call: `429 Too Many Requests`
 * and `509 Bandwidth Limit Exceeded`, which SharePoint sends when a tenant or app is over its
 * bandwidth limit. Each raises the pool's cooldown and ends as `ThrottledError` when it outlasts
 * the retry budget.
 */
const THROTTLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 509]);

/** True when `status` is a Graph HTTP status the retry loop repeats for an idempotent call. */
export function is_retryable_graph_status(status: unknown): boolean {
  return typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status);
}

/** True when `status` is a throttle that backs off the whole pool: 429 or 509. */
export function is_throttle_status(status: unknown): boolean {
  return typeof status === 'number' && THROTTLE_STATUS_CODES.has(status);
}
