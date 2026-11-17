import { Container } from 'inversify';
import { describe, expect, it, vi } from 'vitest';
import { THROTTLE_COORDINATOR_TOKEN } from '@wisecom/atlas-types';
import { release_throttle_cooldowns_if_cancelled } from '@/adapters/throttle-cooldown-release';

/**
 * A drive backup cancelled during a CDN `Retry-After` of up to an hour stopped its transfer, but
 * the cooldown timer the 429 raised kept the process alive until it expired (issue #632). The Teams
 * handler already released it; the drive handlers now share the same step.
 */
function container_with_coordinator(on_deactivation: () => void): Container {
  const container = new Container();
  container
    .bind(THROTTLE_COORDINATOR_TOKEN)
    .toConstantValue({ wait: () => Promise.resolve(), raise: () => undefined });
  container.onDeactivation(THROTTLE_COORDINATOR_TOKEN, on_deactivation);
  // Deactivation only runs for a binding that was resolved, as the run's connectors do.
  container.get(THROTTLE_COORDINATOR_TOKEN);
  return container;
}

describe('release_throttle_cooldowns_if_cancelled', () => {
  it('unbinds the coordinator once the run was cancelled, running its cleanup', async () => {
    const cleared = vi.fn();
    const container = container_with_coordinator(cleared);

    await release_throttle_cooldowns_if_cancelled(container, AbortSignal.abort());

    expect(cleared).toHaveBeenCalledOnce();
    expect(container.isBound(THROTTLE_COORDINATOR_TOKEN)).toBe(false);
  });

  it('leaves the coordinator alone for a run that was not cancelled', async () => {
    const cleared = vi.fn();
    const container = container_with_coordinator(cleared);

    await release_throttle_cooldowns_if_cancelled(container, new AbortController().signal);

    expect(cleared).not.toHaveBeenCalled();
    expect(container.isBound(THROTTLE_COORDINATOR_TOKEN)).toBe(true);
  });

  it('does nothing when no coordinator is bound', async () => {
    await expect(
      release_throttle_cooldowns_if_cancelled(new Container(), AbortSignal.abort()),
    ).resolves.toBeUndefined();
  });
});
