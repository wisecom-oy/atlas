/**
 * Cancellation and timeout plumbing for one `with_graph_retry` attempt: the run's abort signal,
 * the per-attempt timeout, and the waits between attempts.
 */

/**
 * Runs one attempt of `fn` under `timeout_ms`, handing it a signal that fires when the attempt
 * times out or the run is cancelled.
 *
 * Racing alone used to leave a timed-out request running: the retry went out while the first
 * request could still commit, so a slow create landed twice (issue #624). Aborting the signal tears
 * down any request that was given it.
 */
export async function run_attempt<T>(
  fn: (attempt_signal: AbortSignal) => Promise<T>,
  timeout_ms: number,
  run_signal: AbortSignal | undefined,
): Promise<T> {
  const attempt = new AbortController();
  const abort_attempt = (): void => attempt.abort(cancelled_error(run_signal?.reason));
  run_signal?.addEventListener('abort', abort_attempt, { once: true });
  try {
    return await race_timeout(race_abort(fn(attempt.signal), run_signal), timeout_ms, attempt);
  } finally {
    run_signal?.removeEventListener('abort', abort_attempt);
  }
}

/**
 * Waits `ms`, or rejects as soon as `signal` fires. The timer is cleared on abort, so a cancelled
 * run does not hold the process open for the rest of a backoff or Retry-After.
 *
 * A signal that has already fired rejects at once: an `abort` listener added after the event never
 * runs, so without the check a run cancelled just before the wait would sit it out in full.
 */
export async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throw_if_cancelled(signal);
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
export function throw_if_cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled_error(signal.reason);
}

/**
 * Settles like `promise`, but rejects as soon as `signal` fires. The underlying promise keeps
 * running unless its producer also listens to a signal that fires with this one.
 */
export function race_abort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const on_abort = (): void => reject(cancelled_error(signal.reason));
  signal.addEventListener('abort', on_abort, { once: true });
  return Promise.race([promise, aborted]).finally(() =>
    signal.removeEventListener('abort', on_abort),
  );
}

/**
 * Races a promise against a timeout. On expiry it rejects with ETIMEDOUT first, then aborts
 * `attempt`, so the caller sees the timeout rather than the abort it causes.
 */
function race_timeout<T>(promise: Promise<T>, ms: number, attempt: AbortController): Promise<T> {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    const timed_out = Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' });
    reject(timed_out);
    attempt.abort(timed_out);
  }, ms);
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
