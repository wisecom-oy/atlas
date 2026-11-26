/**
 * The cooldown waits of one logical Graph call and the budget they count against: the waits the
 * retry loop makes before each attempt, and the wait before an Outlook call takes its pacing slot.
 */

import {
  get_active_throttle,
  get_active_throttle_pool,
  get_active_throttle_scope,
} from '@wisecom/atlas-core/services/shared/graph-request-context';
import { MAX_COOLDOWN_RELEASE_JITTER_MS } from '@wisecom/atlas-core/services/shared/cooldown-release-jitter';
import { MAX_RETRY_AFTER_MS } from '@/graph-retry-after';
import { race_abort } from '@/graph-attempt-cancellation';
import { ThrottledError } from '@wisecom/atlas-types';

/**
 * Waiting after which one logical call starts no new wait: backoff delays, Retry-After waits and
 * cooldown waits, including the cooldown an Outlook call waits out before it is sent (issue #884).
 * A wait it does start runs in full, so a Retry-After or cooldown up to the 1-hour cap is honoured
 * rather than failed (issue #641), and one call waits at most this budget plus one such wait. Time
 * spent inside an attempt does not count, so a slow download keeps its retries. Sized just above
 * the 12-retry exponential schedule (about 23.5 minutes at the 5-minute cap, plus jitter), so
 * backoff alone always keeps every retry.
 */
export const RETRY_BUDGET_MS = 24 * 60_000;
/** The longest one cooldown wait may run: the Retry-After cap plus the release jitter. */
export const MAX_COOLDOWN_WAIT_MS = MAX_RETRY_AFTER_MS + MAX_COOLDOWN_RELEASE_JITTER_MS;

/** How long a cooldown wait may run: up to the cap while budget remains, otherwise not at all. */
export function cooldown_wait_bound_ms(waited_ms: number): number {
  return waited_ms < RETRY_BUDGET_MS ? MAX_COOLDOWN_WAIT_MS : 0;
}

/** Whether a bounded wait's timer keeps Node running while it waits. */
export interface CooldownWaitOptions {
  /**
   * False when something else already holds the process for the cooldown: the fence timer that
   * ends it does so while a command runs, and is released once the command has ended (issue #873).
   * Defaults to true.
   */
  readonly hold_process?: boolean;
}

/**
 * Waits out any cooldown the ambient coordinator holds for this request's pool, but no longer than
 * `bound_ms`. A cooldown that outlasts it fails the call with the throttle instead of waiting past
 * its bound. Rejects as soon as the run is cancelled, so a cancelled run does not sit out a cooldown
 * of up to an hour. Resolves with the time waited.
 */
export async function wait_out_throttle(
  bound_ms: number,
  abort_signal: AbortSignal | undefined,
  options: CooldownWaitOptions = {},
): Promise<number> {
  const throttle = get_active_throttle();
  const pool = get_active_throttle_pool();
  if (!throttle || !pool) return 0;
  const started = Date.now();
  await race_budget(
    race_abort(throttle.coordinator.wait(pool, get_active_throttle_scope()), abort_signal),
    bound_ms,
    options.hold_process ?? true,
  );
  return Date.now() - started;
}

/** Resolves with `promise`, or rejects with ThrottledError once `ms` elapses first. */
function race_budget(promise: Promise<void>, ms: number, hold_process: boolean): Promise<void> {
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
  if (!hold_process) timer.unref();
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
