import type { OperationControlOptions } from '@wisecom/atlas-types';
import { run_with_abort_signal } from '@/services/shared/graph-request-context';

/** How far down a `cause` chain a wrapped cancellation is looked for. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Runs one backup or restore with its abort signal published to every Graph call inside it, so
 * cancelling also ends a Graph retry or throttle wait rather than only the next item (issue #673).
 *
 * A run cancelled before it could build its own result, say during the first Graph listing,
 * resolves with `interrupted_result()` instead of rejecting. A caller then gets the same
 * `interrupted: true` result whether the signal landed inside a Graph call or between items, and
 * nothing the run would have committed is written.
 *
 * Only the cancellation itself is mapped to that result. Any other error is rethrown even when the
 * signal has fired by then, so a failure that happens to land after Ctrl+C, such as a key that
 * does not decrypt the snapshot, still surfaces as itself rather than as "nothing restored"
 * (issue #682).
 */
export async function run_cancellable<T>(
  control: OperationControlOptions,
  run: () => Promise<T>,
  interrupted_result: () => T,
): Promise<T> {
  try {
    return await run_with_abort_signal(control.abort_signal, run);
  } catch (err) {
    if (!is_cancellation_of(err, control.abort_signal)) throw err;
    return interrupted_result();
  }
}

/**
 * True when `err` is the abort reason of a fired `signal`, or was caused by it.
 *
 * Every cancellation path rejects with the signal's reason, directly or as the `cause` of the
 * error that carries it, so identity is the test. An error that merely arrives after the signal
 * fired is not a cancellation.
 */
export function is_cancellation_of(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted !== true) return false;
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === signal.reason) return true;
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}
