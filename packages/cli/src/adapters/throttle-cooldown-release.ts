import type { Container } from 'inversify';
import { THROTTLE_COORDINATOR_TOKEN, type ThrottleCoordinator } from '@wisecom/atlas-types';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';

/**
 * Drops the throttle cooldowns a run raised, once Ctrl+C has cancelled it.
 *
 * Ctrl+C aborts the request but not the cooldown the run raised. That timer is not unref'd, so it
 * would keep the process alive until the Retry-After expires, which for a CDN throttle can be an
 * hour. Unbinding the coordinator runs its deactivation hook, which clears the fence timers.
 */
export async function release_throttle_cooldowns_if_cancelled(
  container: Container,
  abort_signal: AbortSignal,
): Promise<void> {
  if (!abort_signal.aborted || !container.isBound(THROTTLE_COORDINATOR_TOKEN)) return;
  await container.unbindAsync(THROTTLE_COORDINATOR_TOKEN);
}

/**
 * Lets the process exit once a run has ended, whatever its outcome, while a cooldown is still armed.
 *
 * A run that fails on a Retry-After above the 1-hour cap, or on any error after a 429, leaves the
 * cooldown it raised armed. Its timer kept the process alive for up to an hour after the error was
 * printed, so a scheduler saw a hung job (issue #873). The cooldown is not dropped: anything still
 * parked on it stays parked instead of sending into a pool Graph is throttling.
 */
export function release_throttle_process_hold(container: Container): void {
  if (!container.isBound(THROTTLE_COORDINATOR_TOKEN)) return;
  const coordinator = container.get<ThrottleCoordinator>(THROTTLE_COORDINATOR_TOKEN);
  if (coordinator instanceof InProcessThrottleCoordinator) coordinator.release_process_hold();
}
