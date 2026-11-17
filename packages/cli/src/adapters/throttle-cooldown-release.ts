import type { Container } from 'inversify';
import { THROTTLE_COORDINATOR_TOKEN } from '@wisecom/atlas-types';

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
