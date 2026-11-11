import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  get_active_abort_signal,
  get_active_request_pacing,
  get_active_throttle,
  get_active_throttle_pool,
  get_active_throttle_scope,
} from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  MAX_COOLDOWN_RELEASE_JITTER_MS,
  cooldown_release_jitter_ms,
} from '@wisecom/atlas-core/services/shared/cooldown-release-jitter';
import {
  MAX_RETRY_AFTER_MS,
  extract_requested_retry_after_ms,
  extract_retry_after_ms,
} from '@/graph-retry-after';
import { race_abort, run_attempt, sleep, throw_if_cancelled } from '@/graph-attempt-cancellation';
import { is_network_error } from '@/graph-network-error';
import { ThrottledError } from '@wisecom/atlas-types';

/**
 * Statuses Graph recovers from on its own, per Microsoft's throttling and
 * resilience guidance: the request never reached a working backend, or the
 * gateway gave up on one. 501 and every 4xx stay out -- repeating those
 * returns the same answer.
 *
 * These apply to idempotent calls only. A 5xx or a timeout after a create POST
 * can arrive after the backend committed it, so a call marked `idempotent: false`
 * retries only on a throttle response (see `is_throttle_response`, issue #624).
 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 12;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** Cooldown applied to a 429 that arrives without a usable Retry-After. */
const DEFAULT_THROTTLE_SECONDS = 30;

/**
 * Waiting after which one logical call starts no new wait: backoff delays, Retry-After waits and
 * cooldown waits. A wait it does start runs in full, so a Retry-After or cooldown up to the 1-hour
 * cap is honoured rather than failed (issue #641), and one call waits at most this budget plus one
 * such wait. Time spent inside an attempt does not count, so a slow download keeps its retries.
 * Sized just above the 12-retry exponential schedule (about 23.5 minutes at the 5-minute cap, plus
 * jitter), so backoff alone always keeps every retry.
 */
const RETRY_BUDGET_MS = 24 * 60_000;
/** The longest one cooldown wait may run: the Retry-After cap plus the release jitter. */
const MAX_COOLDOWN_WAIT_MS = MAX_RETRY_AFTER_MS + MAX_COOLDOWN_RELEASE_JITTER_MS;
/** Retry-After values below this are raised to it, so a zero value cannot spin the loop. */
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
  /**
   * False for a write that would land twice if sent twice: a create POST, or a drive PUT whose
   * conflict behaviour renames. Graph can commit such a request and still answer 500, 502 or 504,
   * or answer too late for the timeout, so repeating it creates a duplicate. A non-idempotent call
   * is retried only on a throttle response, which Graph sends instead of processing the request;
   * any other failure is thrown on the first attempt. Defaults to true.
   */
  readonly idempotent?: boolean;
}

/**
 * Whether a failure is Graph refusing the request before processing it: a 429, or a 503 carrying
 * Retry-After, the form SharePoint and OneDrive throttling also takes. Only these are safe to
 * repeat for a write that is not idempotent.
 */
export function is_throttle_response(err: unknown): boolean {
  const status = status_code_of(err);
  if (status === 429) return true;
  return status === 503 && extract_retry_after_ms(err) !== undefined;
}

/** Whether a failed attempt may be sent again, given whether the call is idempotent. */
function is_retry_safe(err: unknown, idempotent: boolean): boolean {
  return idempotent ? is_retryable_error(err) : is_throttle_response(err);
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

/** Returns true when an error is retryable (transient HTTP or network error). */
export function is_retryable_error(err: unknown): boolean {
  return is_transient_error(err) || is_network_error(err);
}

/**
 * Wraps any async network call with exponential backoff + jitter for both
 * transient HTTP errors (429, 500, 502, 503, 504) and network-level errors (ETIMEDOUT,
 * ECONNRESET, socket hang up, etc.).
 *
 * Retries up to 12 times with backoff delays capped at 5 minutes. A call starts no new wait once it
 * has waited 24 minutes, counting waits and cooldowns. Honours Retry-After up to the 1-hour cap,
 * plus a small positive jitter so callers throttled together do not retry together, and fails with
 * ThrottledError naming the value when Retry-After exceeds that cap. Each retry is logged.
 *
 * `fn` receives a signal that fires when its attempt times out or the run is cancelled. A request
 * that passes it to fetch (`.option('signal', signal)` on a Graph request) is torn down rather than
 * left running beside the next attempt. A call marked `idempotent: false` is retried only on a
 * throttle response.
 *
 * This function is designed to be reusable across backup, restore, save, and
 * any other operation that communicates over the network.
 */
export async function with_graph_retry<T>(
  fn: (attempt_signal: AbortSignal) => Promise<T>,
  options: GraphRetryOptions = {},
): Promise<T> {
  const timeout_ms = options.timeout_ms ?? REQUEST_TIMEOUT_MS;
  const idempotent = options.idempotent ?? true;
  const abort_signal = get_active_abort_signal();
  let waited_ms = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    throw_if_cancelled(abort_signal);
    // Per attempt, not per call. A retry loop that started before the cooldown
    // began would otherwise keep firing into Graph for the whole of it.
    waited_ms += await wait_out_throttle(cooldown_wait_bound_ms(waited_ms), abort_signal);
    // Pacing is charged to no budget: it spaces requests out, it is not a cooldown Graph imposed.
    // A cooldown raised while this request waited for its slot is honoured before it is sent.
    const pacing = get_active_request_pacing();
    if (pacing) {
      await pacing.before_attempt(abort_signal);
      waited_ms += await wait_out_throttle(cooldown_wait_bound_ms(waited_ms), abort_signal);
    }
    try {
      return await run_attempt(fn, timeout_ms, abort_signal);
    } catch (err) {
      throw_if_cancelled(abort_signal);
      if (!is_retry_safe(err, idempotent)) throw err;

      const retry_after = floor_retry_after_ms(extract_retry_after_ms(err));
      // Raise on the response that carried the 429, not after the budget is
      // spent, so every other owner backs off during this cooldown too.
      raise_throttle_on_429(err, retry_after);
      if (status_code_of(err) === 429) get_active_request_pacing()?.on_throttled();
      throw_if_retry_after_above_cap(err);
      if (attempt === MAX_RETRIES || waited_ms >= RETRY_BUDGET_MS) {
        throw as_exhausted_failure(err, attempt);
      }

      const delay = retry_delay_ms(attempt, retry_after);
      const reason = describe_graph_error(err);
      logger.debug(
        `Retry ${attempt + 1}/${MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s -- ${reason}`,
      );
      waited_ms += await wait_before_retry(delay, retry_after ?? delay, abort_signal);
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
 * Fails the call with ThrottledError when Graph asked for a Retry-After longer than the 1-hour cap,
 * naming the value it sent. Waiting it out would hold the run for longer than Atlas allows, and
 * retrying early would ignore it. The cooldown is still raised for the capped hour.
 */
function throw_if_retry_after_above_cap(err: unknown): void {
  const requested_ms = extract_requested_retry_after_ms(err);
  if (requested_ms === undefined || requested_ms <= MAX_RETRY_AFTER_MS) return;
  throw new ThrottledError(
    `Microsoft Graph asked to wait ${Math.round(requested_ms / 1000)} s (Retry-After), longer ` +
      `than the ${MAX_RETRY_AFTER_MS / 1000} s Atlas waits out: ${describe_graph_error(err)}`,
    requested_ms,
    { cause: err },
  );
}

/** How long a cooldown wait may run: up to the cap while budget remains, otherwise not at all. */
function cooldown_wait_bound_ms(waited_ms: number): number {
  return waited_ms < RETRY_BUDGET_MS ? MAX_COOLDOWN_WAIT_MS : 0;
}

/**
 * Waits out any cooldown the ambient coordinator holds for this request's pool, but no longer than
 * `bound_ms`. A cooldown that outlasts it fails the call with the throttle instead of waiting past
 * its bound. Rejects as soon as the run is cancelled, so a cancelled run does not sit out a cooldown
 * of up to an hour. Resolves with the time waited.
 */
async function wait_out_throttle(
  bound_ms: number,
  abort_signal: AbortSignal | undefined,
): Promise<number> {
  const throttle = get_active_throttle();
  const pool = get_active_throttle_pool();
  if (!throttle || !pool) return 0;
  const started = Date.now();
  await race_budget(
    race_abort(throttle.coordinator.wait(pool, get_active_throttle_scope()), abort_signal),
    bound_ms,
  );
  return Date.now() - started;
}

/**
 * Waits before the next attempt and resolves with the time waited. The coordinator goes first: a
 * 429 has just raised its cooldown, and it releases this call with the jitter it gives every other
 * caller parked on it. A local sleep covers what it did not, so with no coordinator, or a host
 * coordinator that failed open, the call still waits `delay_ms`. Never resumes before
 * `min_wait_ms`, the Retry-After Graph asked for.
 */
async function wait_before_retry(
  delay_ms: number,
  min_wait_ms: number,
  abort_signal: AbortSignal | undefined,
): Promise<number> {
  const started = Date.now();
  const covered_ms = await wait_out_throttle(MAX_COOLDOWN_WAIT_MS, abort_signal);
  if (covered_ms < min_wait_ms) await sleep(delay_ms - covered_ms, abort_signal);
  return Date.now() - started;
}

/**
 * Raises a Retry-After below MIN_RETRY_AFTER_MS to that floor, so a zero value still waits a moment
 * and raises a real cooldown. Other values, and an absent one, pass through unchanged.
 */
function floor_retry_after_ms(retry_after_ms: number | undefined): number | undefined {
  if (retry_after_ms === undefined || retry_after_ms >= MIN_RETRY_AFTER_MS) return retry_after_ms;
  return MIN_RETRY_AFTER_MS;
}

/** Resolves with `promise`, or rejects with ThrottledError once `ms` elapses first. */
function race_budget(promise: Promise<void>, ms: number): Promise<void> {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () =>
      reject(
        new ThrottledError(
          `Microsoft Graph cooldown outlasted the ${Math.round(ms / 1000)} s Atlas waits out`,
        ),
      ),
    Math.max(ms, 0),
  );
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * The wait before the next attempt. A Retry-After, already capped at one hour, is honoured plus a
 * small positive jitter (`cooldown_release_jitter_ms`), so calls throttled together do not retry in
 * the same instant and never retry before Graph asked. Without one, jittered exponential backoff
 * capped at MAX_DELAY_MS.
 */
function retry_delay_ms(attempt: number, retry_after_ms: number | undefined): number {
  if (retry_after_ms === undefined) {
    return Math.min(BASE_DELAY_MS * 2 ** attempt + Math.random() * BASE_DELAY_MS, MAX_DELAY_MS);
  }
  return retry_after_ms + cooldown_release_jitter_ms(retry_after_ms);
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
 *
 * Only the numeric status decides. A caller records a match as permanently
 * skipped, and the message text of any other failure (request ids, item ids,
 * byte counts) can contain "404" or "Not Found" by chance (issue #618). A
 * binary download's error carries the status and an empty message, which is
 * enough.
 */
export function is_content_gone_error(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const graph_err = err as Record<string, unknown>;
  const status = graph_err.statusCode ?? graph_err.status;
  return status === 404 || status === 410;
}
