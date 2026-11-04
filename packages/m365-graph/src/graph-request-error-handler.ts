import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  get_active_abort_signal,
  get_active_throttle,
  get_active_throttle_pool,
  get_active_throttle_scope,
} from '@wisecom/atlas-core/services/shared/graph-request-context';
import { extract_retry_after_ms } from '@/graph-retry-after';
import { ThrottledError } from '@wisecom/atlas-types';

/**
 * Statuses Graph recovers from on its own, per Microsoft's throttling and
 * resilience guidance: the request never reached a working backend, or the
 * gateway gave up on one. 501 and every 4xx stay out -- repeating those
 * returns the same answer.
 *
 * ponytail: one set for reads and writes. A 500 on a create POST can retry a
 * request the backend already committed, which restore surfaces as a duplicate
 * item -- the same exposure 504 already carried. Thread an idempotency flag
 * through GraphRetryOptions and opt the restore writers out if duplicates ever
 * show up in practice.
 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const MAX_RETRIES = 12;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** Cooldown applied to a 429 that arrives without a usable Retry-After. */
const DEFAULT_THROTTLE_SECONDS = 30;

/**
 * Ceiling on the time one logical call spends waiting: backoff delays, Retry-After waits and
 * cooldown waits. Time spent inside an attempt does not count, so a slow download keeps its
 * retries. Sized just above the 12-retry exponential schedule (about 23.5 minutes at the 5-minute
 * cap, plus jitter), so backoff alone always keeps every retry; Retry-After and cooldown waits are
 * what it bounds.
 */
const RETRY_BUDGET_MS = 24 * 60_000;
/** Retry-After values below this are raised to it, with jitter, so a zero value cannot spin the loop. */
const MIN_RETRY_AFTER_MS = 1_000;

export interface GraphRetryOptions {
  /**
   * Per-attempt timeout. The default 60s bounds a single Graph request --
   * NEVER wrap a multi-page enumeration in one with_graph_retry call: the
   * timeout races the whole loop, restarts it from page 1 on expiry, and the
   * losing arm keeps consuming Graph quota (issue #33). Retry per page so the
   * paginator resumes from @odata.nextLink. Large single-object transfers
   * (attachment $value, file content) should pass a bigger window -- corso
   * converged on 1h default / 48h for large files against production tenants.
   */
  readonly timeout_ms?: number;
}

const INVALID_DELTA_CODES = ['syncstatenotfound', 'resyncrequired', 'syncstateinvalid'];

/**
 * Detects Graph errors that indicate an invalid/expired delta token: syncStateNotFound,
 * resyncRequired or syncStateInvalid (Corso's set).
 *
 * The SDK's `GraphError` keeps Graph's error code on `code` and Graph's prose as the message, and
 * the prose does not repeat the code: a rejected drive token arrives as code `resyncRequired` with
 * the message "Resync required. Replace any local items...". Matching the message alone missed it,
 * so the delta failed instead of re-enumerating. Both are read: the code for a `GraphError`, the
 * message for errors that carry the code only there.
 */
export function is_invalid_delta_error(err: unknown): boolean {
  const code = err !== null && typeof err === 'object' && 'code' in err ? err.code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const text = `${typeof code === 'string' ? code : ''} ${message}`.toLowerCase();
  return INVALID_DELTA_CODES.some((known) => text.includes(known));
}

/**
 * Returns true when the error carries a transient HTTP status (429, 500, 502, 503, 504), or is the
 * `ThrottledError` an exhausted 429 becomes, so an outer retry loop still sees a throttle.
 */
export function is_transient_error(err: unknown): boolean {
  if (err instanceof ThrottledError) return true;
  const status = (err as Record<string, unknown>).statusCode;
  return typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Returns true for network-level errors (socket timeout, DNS failure,
 * connection reset) that are worth retrying.
 */
export function is_network_error(err: unknown): boolean {
  const code = (err as Record<string, unknown>).code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes('socket hang up') ||
    lower.includes('network request failed') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('terminated') ||
    lower.includes('aborted') ||
    lower.includes('network error') ||
    lower.includes('client network socket disconnected')
  );
}

/** Returns true when an error is retryable (transient HTTP or network error). */
export function is_retryable_error(err: unknown): boolean {
  return is_transient_error(err) || is_network_error(err);
}

/**
 * Wraps any async network call with exponential backoff + jitter for both
 * transient HTTP errors (429, 500, 502, 503, 504) and network-level errors (ETIMEDOUT,
 * ECONNRESET, socket hang up, etc.).
 *
 * Retries up to 12 times with delays capped at 5 minutes. A call stops retrying when its next
 * wait would pass a 24 minute budget, counting waits and cooldowns, so one call cannot outlast it.
 * Respects Retry-After on 429 exactly, and fails with ThrottledError when Retry-After exceeds the
 * 5-minute cap. Each retry is logged for observability.
 *
 * This function is designed to be reusable across backup, restore, save, and
 * any other operation that communicates over the network.
 */
export async function with_graph_retry<T>(
  fn: () => Promise<T>,
  options: GraphRetryOptions = {},
): Promise<T> {
  const timeout_ms = options.timeout_ms ?? REQUEST_TIMEOUT_MS;
  const abort_signal = get_active_abort_signal();
  let waited_ms = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    throw_if_cancelled(abort_signal);
    // Per attempt, not per call. A retry loop that started before the cooldown
    // began would otherwise keep firing into Graph for the whole of it.
    waited_ms += await wait_out_throttle(RETRY_BUDGET_MS - waited_ms, abort_signal);
    try {
      return await race_timeout(race_abort(fn(), abort_signal), timeout_ms);
    } catch (err) {
      throw_if_cancelled(abort_signal);
      if (!is_retryable_error(err)) throw err;

      const retry_after = floor_retry_after_ms(extract_retry_after_ms(err));
      // Raise on the response that carried the 429, not after the budget is
      // spent, so every other owner backs off during this cooldown too.
      raise_throttle_on_429(err, retry_after);
      const delay = retry_delay_ms(attempt, retry_after);
      if (attempt === MAX_RETRIES || delay === undefined || waited_ms + delay > RETRY_BUDGET_MS) {
        throw as_exhausted_failure(err, attempt);
      }

      const reason = describe_graph_error(err);
      logger.debug(
        `Retry ${attempt + 1}/${MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s -- ${reason}`,
      );

      waited_ms += delay;
      await sleep(delay, abort_signal);
    }
  }
  throw new Error('with_graph_retry: unreachable');
}

/**
 * Turns a 429 that outlasted the retry budget into the documented `ThrottledError`, keeping the
 * Graph error as `cause`. Other exhausted failures are rethrown unchanged (issue #440).
 */
function as_exhausted_failure(err: unknown, retries: number): unknown {
  if (status_code_of(err) !== 429) return err;
  return new ThrottledError(
    `Microsoft Graph kept throttling the request after ${retries} retries: ` +
      describe_graph_error(err),
    extract_retry_after_ms(err),
    { cause: err },
  );
}

/** The HTTP status a Graph or network error carries, or undefined when it carries none. */
function status_code_of(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'statusCode' in err
    ? err.statusCode
    : undefined;
}

/**
 * Waits out any cooldown the ambient coordinator holds for this request's pool, but no longer than
 * the budget left. A cooldown another owner raised can outlast the budget; the call then fails
 * with the throttle instead of waiting past its own bound. Rejects as soon as the run is cancelled,
 * so a cancelled run does not sit out a cooldown of up to an hour. Resolves with the time waited.
 */
async function wait_out_throttle(
  budget_ms: number,
  abort_signal: AbortSignal | undefined,
): Promise<number> {
  const throttle = get_active_throttle();
  const pool = get_active_throttle_pool();
  if (!throttle || !pool) return 0;
  const started = Date.now();
  await race_budget(
    race_abort(throttle.coordinator.wait(pool, get_active_throttle_scope()), abort_signal),
    budget_ms,
  );
  return Date.now() - started;
}

/**
 * Raises a Retry-After below MIN_RETRY_AFTER_MS to a jittered floor, so a zero value still waits
 * a moment and raises a real cooldown. Other values, and an absent one, pass through unchanged.
 */
function floor_retry_after_ms(retry_after_ms: number | undefined): number | undefined {
  if (retry_after_ms === undefined || retry_after_ms >= MIN_RETRY_AFTER_MS) return retry_after_ms;
  return MIN_RETRY_AFTER_MS + Math.random() * MIN_RETRY_AFTER_MS;
}

/** Resolves with `promise`, or rejects with ThrottledError once `ms` elapses first. */
function race_budget(promise: Promise<void>, ms: number): Promise<void> {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => reject(new ThrottledError('Microsoft Graph cooldown outlasted the retry budget')),
    Math.max(ms, 0),
  );
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * The wait before the next attempt. A Retry-After is honoured exactly: jitter would overrun it, and
 * the cooldown raised from the same value already holds every other request for that long. Without
 * one, jittered exponential backoff capped at MAX_DELAY_MS. Undefined when Retry-After exceeds that
 * cap: waiting it out would break the cap and retrying early would ignore it, so the call fails.
 */
function retry_delay_ms(attempt: number, retry_after_ms: number | undefined): number | undefined {
  if (retry_after_ms === undefined) {
    return Math.min(BASE_DELAY_MS * 2 ** attempt + Math.random() * BASE_DELAY_MS, MAX_DELAY_MS);
  }
  return retry_after_ms <= MAX_DELAY_MS ? retry_after_ms : undefined;
}

/**
 * Reports a 429 to the ambient throttle coordinator, so the cooldown starts on
 * the first throttled response rather than after a retry budget is spent.
 *
 * Only 429 raises a cooldown. A 500 or a socket reset is one unlucky request and
 * is the retry loop's business alone; a 429 is Graph asking the whole client to
 * slow down. Cooldowns are non-additive, so concurrent owners hitting the same
 * one extend it rather than stacking it.
 */
function raise_throttle_on_429(err: unknown, retry_after_ms: number | undefined): void {
  if (status_code_of(err) !== 429) return;

  const throttle = get_active_throttle();
  const pool = get_active_throttle_pool();
  if (!throttle || !pool) return;

  throttle.coordinator.raise(
    pool,
    retry_after_ms ?? DEFAULT_THROTTLE_SECONDS * 1000,
    get_active_throttle_scope(),
  );
}

/**
 * Renders any Graph/network error as a non-empty, actionable one-liner.
 * Graph SDK errors routinely carry an empty `message` with the useful part in
 * `statusCode`/`code`/`body`, so every available facet is joined rather than
 * picking the first one present (issue #92).
 */
export function describe_graph_error(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err !== 'object') return String(err);

  const graph_err = err as Record<string, unknown>;
  const status = graph_err.statusCode ?? graph_err.status;
  const message = err instanceof Error ? err.message.trim() : '';
  const parts = [
    typeof status === 'number' || typeof status === 'string' ? `HTTP ${status}` : '',
    typeof graph_err.code === 'string' ? graph_err.code.trim() : '',
    message.slice(0, 200),
    message === '' && typeof graph_err.body === 'string' ? graph_err.body.slice(0, 200) : '',
  ].filter((part) => part !== '');

  return parts.length > 0 ? parts.join(' -- ') : `unknown error (${err.constructor.name})`;
}

/**
 * HTTP 404/410: the content is gone for good (version purged by retention,
 * item hard-deleted). Distinct from a transient failure -- callers count these
 * as expected, not as backup errors.
 */
export function is_content_gone_error(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const graph_err = err as Record<string, unknown>;
  const status = graph_err.statusCode ?? graph_err.status;
  if (status === 404 || status === 410) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('404') || message.includes('Not Found') || message.includes('410');
}

/**
 * Waits `ms`, or rejects as soon as `signal` fires. The timer is cleared on abort, so a cancelled
 * run does not hold the process open for the rest of a backoff or Retry-After.
 */
async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const on_abort = (): void => {
    clearTimeout(timer);
    reject(cancelled_error(signal?.reason));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', on_abort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', on_abort, { once: true });
  await promise;
}

/** The error a cancelled run rejects with: the signal's reason when it is an Error. */
function cancelled_error(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('The run was cancelled');
}

/** Throws the run's cancellation error when `signal` has already fired. */
function throw_if_cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled_error(signal.reason);
}

/**
 * Settles like `promise`, but rejects as soon as `signal` fires. The underlying promise keeps
 * running; Graph gives no way to cancel a request already in flight through this wrapper.
 */
function race_abort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const on_abort = (): void => reject(cancelled_error(signal.reason));
  signal.addEventListener('abort', on_abort, { once: true });
  return Promise.race([promise, aborted]).finally(() =>
    signal.removeEventListener('abort', on_abort),
  );
}

/** Races a promise against a timeout; rejects with ETIMEDOUT on expiry. */
function race_timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
