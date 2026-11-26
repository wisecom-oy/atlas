import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  get_active_abort_signal,
  get_active_request_pacing,
  get_active_throttle,
  get_active_throttle_pool,
  get_active_throttle_scope,
} from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  get_active_graph_outage_signal,
  record_graph_outage,
} from '@wisecom/atlas-core/services/shared/graph-outage-latch';
import {
  MAX_COOLDOWN_RELEASE_JITTER_MS,
  cooldown_release_jitter_ms,
} from '@wisecom/atlas-core/services/shared/cooldown-release-jitter';
import {
  MAX_RETRY_AFTER_MS,
  extract_requested_retry_after_ms,
  extract_retry_after_ms,
} from '@/graph-retry-after';
import {
  link_signals,
  race_abort,
  run_attempt,
  sleep,
  throw_if_cancelled,
} from '@/graph-attempt-cancellation';
import { is_network_error } from '@/graph-network-error';
import { is_permanent_item_error } from '@/graph-permanent-item-errors';
import { is_retryable_graph_status, is_throttle_status } from '@/graph-retryable-status';
import { is_unreadable_success_body } from '@/graph-unreadable-body';
import { to_graph_unavailable_error } from '@/graph-unavailable-failure';
import {
  GraphTokenRequestError,
  is_transient_token_request_error,
  to_token_unavailable_error,
  token_request_refusal,
  token_request_retry_after_ms,
} from '@/graph-token-failure';
import { NewTokenRepeat, is_graph_unauthorized } from '@/graph-unauthorized-retry';
import { get_active_graph_attempt } from '@/graph-attempt';
import { rethrow_if_stopped_before_send } from '@/graph-token-wait';
import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';

const MAX_RETRIES = 12;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** Cooldown applied to a 429 or 509 that arrives without a usable Retry-After. */
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
  /**
   * True for a write whose outcome must not become unknowable: once the request is sent, a
   * cancelled run lets it finish (up to `timeout_ms`) instead of aborting it. Graph may already
   * have committed an aborted write, so the caller would report as not written a file or message
   * that exists. Waits before a send stay cancellable. Defaults to false (issue #682).
   */
  readonly complete_in_flight?: boolean;
}

/**
 * Whether a failure is Graph refusing the request before processing it: a 429, or a 503 carrying
 * Retry-After, the form SharePoint and OneDrive throttling also takes. Only these are safe to
 * repeat for a write that is not idempotent. A 509 is not among them: nothing documents that Graph
 * refuses a write with it before processing, so a write answered 509 is not sent again (#867).
 */
export function is_throttle_response(err: unknown): boolean {
  const status = status_code_of(err);
  if (status === 429) return true;
  return status === 503 && extract_retry_after_ms(err) !== undefined;
}

/**
 * Whether a failed attempt may be sent again, given whether the call is idempotent. A failed token
 * request never sent the Graph request, so repeating it cannot duplicate a write.
 */
function is_retry_safe(err: unknown, idempotent: boolean): boolean {
  if (is_transient_token_request_error(err)) return true;
  return idempotent ? is_retryable_error(err) : is_throttle_response(err);
}

/**
 * Claims a retry for a failed attempt: true when it is safe to send again, or when it is a `401`
 * that takes the call's one repeat with a newly issued token (issue #861).
 */
function claim_retry(err: unknown, idempotent: boolean, new_token_repeat: NewTokenRepeat): boolean {
  return is_retry_safe(err, idempotent) || new_token_repeat.claim(err, idempotent);
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
 * Returns true when the error carries a transient HTTP status (408, 429, 500, 502, 503, 504, 509;
 * see `graph-retryable-status.ts`), or is the
 * `ThrottledError` or `GraphUnavailableError` an exhausted retry becomes, so an outer retry loop
 * still sees the transient failure it wraps. A 500 whose Graph code is permanent for the item,
 * such as `ErrorMimeContentConversionFailed`, is not transient (issue #812).
 */
export function is_transient_error(err: unknown): boolean {
  if (err instanceof ThrottledError || err instanceof GraphUnavailableError) return true;
  if (is_permanent_item_error(err)) return false;
  return is_retryable_graph_status((err as Record<string, unknown>).statusCode);
}

/**
 * Returns true when an error is retryable: a transient HTTP status, a network error, a 2xx whose
 * JSON body did not parse (issue #868), or a failed token request.
 */
export function is_retryable_error(err: unknown): boolean {
  return (
    is_transient_error(err) ||
    is_network_error(err) ||
    is_unreadable_success_body(err) ||
    is_transient_token_request_error(err)
  );
}

/**
 * Wraps any async network call with exponential backoff + jitter for both
 * transient HTTP errors (408, 429, 500, 502, 503, 504, 509), network-level errors (ETIMEDOUT,
 * ECONNRESET, socket hang up, etc.) and a 2xx whose JSON body did not parse.
 *
 * Retries up to 12 times with backoff delays capped at 5 minutes. A call starts no new wait once it
 * has waited 24 minutes, counting waits and cooldowns. Honours Retry-After up to the 1-hour cap,
 * plus a small positive jitter so callers throttled together do not retry together, and fails with
 * ThrottledError naming the value when Retry-After exceeds that cap. Each retry is logged.
 *
 * `fn` receives a signal that fires when its attempt times out or the run is cancelled. A request
 * that passes it to fetch (`.option('signal', signal)` on a Graph request) is torn down rather than
 * left running beside the next attempt. A call marked `idempotent: false` is retried only on a
 * throttle response. A 401 is repeated once, with a newly issued token. A failed token request waits
 * at least MSAL's throttle window before its repeat, since MSAL replays the failure until then.
 *
 * Inside a backup run (`run_stopping_on_graph_outage`), a call that spends its budget records the
 * outage for the whole run, and every call of the run then throws that outage instead of sending a
 * request or starting a wait, so one incident costs the run one budget rather than one per unit of
 * work (issue #881).
 *
 * This function is designed to be reusable across backup, restore, save, and
 * any other operation that communicates over the network.
 */
export async function with_graph_retry<T>(
  fn: (attempt_signal: AbortSignal) => Promise<T>,
  options: GraphRetryOptions = {},
): Promise<T> {
  // A call made inside another call's attempt is abandoned with that attempt (issue #888).
  const cancel = link_signals(get_active_abort_signal(), get_active_graph_attempt()?.signal);
  const stop = link_signals(cancel.signal, get_active_graph_outage_signal());
  try {
    return await retry_until_settled(fn, options, { cancel: cancel.signal, stop: stop.signal });
  } catch (err) {
    record_graph_outage(err);
    throw err;
  } finally {
    stop.release();
    cancel.release();
  }
}

/**
 * What ends a call early: `cancel` when the run is cancelled or the attempt that made this call was
 * abandoned, `stop` on either of those or an outage of the run.
 */
interface CallStopSignals {
  readonly cancel: AbortSignal | undefined;
  readonly stop: AbortSignal | undefined;
}

/**
 * The retry loop of `with_graph_retry`. Every wait, and the start of every attempt, ends as soon as
 * `signals.stop` fires: the run was cancelled, or another call of the run spent its budget. A
 * request already sent is cut off only by cancellation, so a read in flight still completes, and a
 * request still waiting for its token is not sent.
 */
async function retry_until_settled<T>(
  fn: (attempt_signal: AbortSignal) => Promise<T>,
  options: GraphRetryOptions,
  signals: CallStopSignals,
): Promise<T> {
  const timeout_ms = options.timeout_ms ?? REQUEST_TIMEOUT_MS;
  const idempotent = options.idempotent ?? true;
  const { cancel: cancel_signal, stop: stop_signal } = signals;
  // What may cut off a request already sent; waits before a send honour `stop_signal`.
  const in_flight_signal = options.complete_in_flight === true ? undefined : cancel_signal;
  let waited_ms = 0;
  const new_token_repeat = new NewTokenRepeat();
  const started_at = Date.now();
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    throw_if_cancelled(stop_signal);
    // Per attempt, not per call. A retry loop that started before the cooldown
    // began would otherwise keep firing into Graph for the whole of it.
    waited_ms += await wait_out_throttle(cooldown_wait_bound_ms(waited_ms), stop_signal);
    // Pacing is charged to no budget: it spaces requests out, it is not a cooldown Graph imposed.
    // A cooldown raised while this request waited for its slot is honoured before it is sent.
    const pacing = get_active_request_pacing();
    if (pacing) {
      await pacing.before_attempt(stop_signal);
      waited_ms += await wait_out_throttle(cooldown_wait_bound_ms(waited_ms), stop_signal);
    }
    try {
      return await run_attempt(fn, timeout_ms, {
        in_flight: in_flight_signal,
        before_send: stop_signal,
      });
    } catch (err) {
      throw_if_cancelled(cancel_signal);
      rethrow_if_stopped_before_send(err);
      if (!claim_retry(err, idempotent, new_token_repeat)) throw as_final_failure(err);

      const retry_after = requested_wait_ms(err);
      // Raise on the response that carried the 429 or 509, not after the budget
      // is spent, so every other owner backs off during this cooldown too.
      raise_throttle_on_throttle_status(err, retry_after);
      if (is_throttle_status(status_code_of(err))) get_active_request_pacing()?.on_throttled();
      throw_if_retry_after_above_cap(err);
      if (attempt === MAX_RETRIES || waited_ms >= RETRY_BUDGET_MS) {
        throw as_exhausted_failure(err, attempt, Date.now() - started_at);
      }

      const delay = retry_delay_ms(attempt, retry_after);
      const reason = describe_graph_error(err);
      logger.debug(
        `Retry ${attempt + 1}/${MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s -- ${reason}`,
      );
      waited_ms += await wait_before_retry(delay, retry_after ?? delay, stop_signal);
    }
  }
  throw new Error('with_graph_retry: unreachable');
}

/**
 * The error to throw for a failure that is not retried: the `AuthError` a refused token request
 * carries through the Graph SDK (issue #786), otherwise the failure itself.
 */
function as_final_failure(err: unknown): unknown {
  return token_request_refusal(err) ?? err;
}

/**
 * Types a retryable failure that outlasted the retry budget, keeping the Graph error as `cause`:
 * a 429 or 509 becomes `ThrottledError` (issues #440, #867), and a 408, 5xx, network error,
 * timeout or 2xx whose JSON body did not parse becomes `GraphUnavailableError` (issues #773, #867,
 * #868). A Graph SDK error for a 5xx with an empty or non-JSON body has an empty `message`, so the
 * message is built from `describe_graph_error`, never copied.
 */
function as_exhausted_failure(err: unknown, retries: number, elapsed_ms: number): unknown {
  // An inner call already typed its exhausted failure; wrapping it again would hide a throttle.
  if (err instanceof ThrottledError || err instanceof GraphUnavailableError) return err;
  // A 401 on the last attempt is a refused token, not an outage.
  if (is_graph_unauthorized(err)) return err;
  if (err instanceof GraphTokenRequestError) {
    return to_token_unavailable_error(err, { retries, elapsed_ms });
  }
  if (is_throttle_status(status_code_of(err))) {
    return new ThrottledError(
      `Microsoft Graph kept throttling the request after ${retries} retries: ` +
        describe_graph_error(err),
      extract_retry_after_ms(err),
      { cause: err },
    );
  }
  return to_graph_unavailable_error(err, { retries, elapsed_ms }, describe_graph_error);
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
 * The wait a failure asks for before its repeat: Graph's Retry-After, or for a failed token request
 * the window in which MSAL would replay the failure instead of asking Entra ID again.
 */
function requested_wait_ms(err: unknown): number | undefined {
  return floor_retry_after_ms(extract_retry_after_ms(err) ?? token_request_retry_after_ms(err));
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
 * Reports a 429 or 509 to the ambient throttle coordinator, so the cooldown starts on
 * the first throttled response rather than after a retry budget is spent.
 *
 * Only a throttle status raises a cooldown. A 500 or a socket reset is one unlucky
 * request and is the retry loop's business alone; a 429, or SharePoint's 509
 * Bandwidth Limit Exceeded, is Graph asking the whole client to slow down (issue #867).
 * Cooldowns are non-additive, so concurrent owners hitting the same one extend it
 * rather than stacking it.
 */
function raise_throttle_on_throttle_status(err: unknown, retry_after_ms: number | undefined): void {
  if (!is_throttle_status(status_code_of(err))) return;

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
