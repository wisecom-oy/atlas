/**
 * Cancellation and timeout plumbing for one `with_graph_retry` attempt: the run's abort signal,
 * the per-attempt timeout, and the waits between attempts.
 */

import {
  GraphAttempt,
  cancelled_error,
  run_in_graph_attempt,
  type AttemptStopSignals,
} from '@/graph-attempt';

/**
 * Runs one attempt of `fn` under `timeout_ms`, handing it a signal that fires when the attempt
 * times out or `stops.in_flight` fires.
 *
 * Racing alone used to leave a timed-out request running: the retry went out while the first
 * request could still commit, so a slow create landed twice (issue #624). The attempt runs as a
 * `GraphAttempt`, so every request it sends is torn down on expiry, whether or not `fn` passes the
 * signal on (issue #888), and a request still waiting for its token is never sent (issue #889).
 */
export async function run_attempt<T>(
  fn: (attempt_signal: AbortSignal) => Promise<T>,
  timeout_ms: number,
  stops: AttemptStopSignals,
): Promise<T> {
  const attempt = new GraphAttempt(stops);
  const expired = attempt.arm_timeout(timeout_ms);
  const work = run_in_graph_attempt(attempt, async () => await fn(attempt.signal));
  const settle = (): void => attempt.settle();
  work.then(settle, settle);
  return await Promise.race([race_abort(work, stops.in_flight), expired]);
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

/** A signal that fires when either of two signals fires, and the function that detaches it. */
export interface LinkedSignal {
  readonly signal: AbortSignal | undefined;
  readonly release: () => void;
}

const NOTHING_TO_RELEASE = (): void => undefined;

/**
 * Links two optional signals into one that fires with the reason of whichever fires first, so a
 * cancellation keeps its identity. One listener per input, removed by `release`, rather than
 * `AbortSignal.any` per call: the inputs outlive every Graph call of the run.
 */
export function link_signals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): LinkedSignal {
  if (first === undefined || first.aborted || second === undefined) {
    return { signal: first ?? second, release: NOTHING_TO_RELEASE };
  }
  if (second.aborted) return { signal: second, release: NOTHING_TO_RELEASE };
  const linked = new AbortController();
  const forward_first = (): void => linked.abort(first.reason);
  const forward_second = (): void => linked.abort(second.reason);
  first.addEventListener('abort', forward_first, { once: true });
  second.addEventListener('abort', forward_second, { once: true });
  return {
    signal: linked.signal,
    release: (): void => {
      first.removeEventListener('abort', forward_first);
      second.removeEventListener('abort', forward_second);
    },
  };
}
