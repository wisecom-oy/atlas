import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  get_active_request_pacing,
  run_with_request_pacing,
  type RequestPacing,
} from '@/services/shared/graph-request-context';
import { InProcessThrottleCoordinator } from '@/services/shared/in-process-throttle-coordinator';

const NO_WAIT: RequestPacing = { before_attempt: async () => {}, on_throttled: () => {} };

describe('run_with_request_pacing', () => {
  it('publishes the hook only inside the run it wraps', () => {
    expect(get_active_request_pacing()).toBeUndefined();

    run_with_request_pacing(NO_WAIT, () => {
      expect(get_active_request_pacing()).toBe(NO_WAIT);
    });

    expect(get_active_request_pacing()).toBeUndefined();
  });
});

describe('InProcessThrottleCoordinator teams owner scope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cools one team without cooling other teams or the pool-wide fence', () => {
    const coordinator = new InProcessThrottleCoordinator();

    coordinator.raise('teams', 5_000, { ownerId: 'team-a' });

    expect(coordinator.is_cooling('teams', { ownerId: 'team-a' })).toBe(true);
    expect(coordinator.is_cooling('teams', { ownerId: 'team-b' })).toBe(false);
    expect(coordinator.is_cooling('teams')).toBe(false);
  });

  it('lets a team resume once its cooldown has passed', () => {
    const coordinator = new InProcessThrottleCoordinator();

    coordinator.raise('teams', 5_000, { ownerId: 'team-a' });
    vi.advanceTimersByTime(5_001);

    expect(coordinator.is_cooling('teams', { ownerId: 'team-a' })).toBe(false);
  });
});
