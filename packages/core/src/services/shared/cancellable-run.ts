import type { OperationControlOptions } from '@wisecom/atlas-types';
import { run_with_abort_signal } from '@/services/shared/graph-request-context';

/**
 * Runs one backup or restore with its abort signal published to every Graph call inside it, so
 * cancelling also ends a Graph retry or throttle wait rather than only the next item (issue #673).
 *
 * A run cancelled before it could build its own result, say during the first Graph listing,
 * resolves with `interrupted_result()` instead of rejecting. A caller then gets the same
 * `interrupted: true` result whether the signal landed inside a Graph call or between items, and
 * nothing the run would have committed is written.
 */
export async function run_cancellable<T>(
  control: OperationControlOptions,
  run: () => Promise<T>,
  interrupted_result: () => T,
): Promise<T> {
  try {
    return await run_with_abort_signal(control.abort_signal, run);
  } catch (err) {
    if (control.abort_signal?.aborted !== true) throw err;
    return interrupted_result();
  }
}
