/**
 * The cooldown an Outlook call waits out before it takes its mailbox's pacing slot, and the
 * hand-over of that wait to the retry budget of the Graph call it then makes.
 *
 * The wait has to come first: a call parked on a cooldown must not hold window tokens or one of
 * the mailbox's four concurrency slots for up to an hour. It is still a cooldown wait, so it counts
 * against the call's 24-minute budget like the waits inside the retry loop (issue #884), and ends as
 * soon as the run is cancelled (issue #874).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { record_graph_outage } from '@wisecom/atlas-core/services/shared/graph-outage-latch';
import { throw_if_cancelled } from '@/graph-attempt-cancellation';
import { MAX_COOLDOWN_WAIT_MS, wait_out_throttle } from '@/graph-cooldown-wait';

/** The cooldown wait not yet charged to a retry budget. */
interface UnchargedWait {
  waited_ms: number;
}

const _uncharged = new AsyncLocalStorage<UnchargedWait>();

/**
 * Waits out the cooldown of the ambient pool and owner before a call is sent, and resolves with
 * the time waited. Rejects as soon as `stop_signal` fires, so neither a cancelled run nor one that
 * already recorded an outage sits out the cooldown, and nothing is sent early. A cooldown that
 * outlasts one full cooldown wait, because other requests keep raising it, fails the call with
 * `ThrottledError`, which ends the run as an exhausted budget does.
 *
 * Its timer does not hold the process: the fence timer that ends the cooldown does that while the
 * command runs, and lets go once it has ended (issue #873).
 */
export async function wait_out_cooldown_before_send(
  stop_signal: AbortSignal | undefined,
): Promise<number> {
  try {
    throw_if_cancelled(stop_signal);
    return await wait_out_throttle(MAX_COOLDOWN_WAIT_MS, stop_signal, { hold_process: false });
  } catch (err) {
    record_graph_outage(err);
    throw err;
  }
}

/** Runs `fn` with `waited_ms` to be charged to the retry budget of the first Graph call it makes. */
export function run_with_uncharged_wait<T>(waited_ms: number, fn: () => T): T {
  return _uncharged.run({ waited_ms }, fn);
}

/**
 * Takes the wait spent before this call was sent, so its retry loop starts its budget from there.
 * Taken once: a later Graph call in the same connector call, such as the next page of a listing,
 * starts from zero, as it always has.
 */
export function take_uncharged_wait_ms(): number {
  const uncharged = _uncharged.getStore();
  if (!uncharged) return 0;
  const waited_ms = uncharged.waited_ms;
  uncharged.waited_ms = 0;
  return waited_ms;
}
