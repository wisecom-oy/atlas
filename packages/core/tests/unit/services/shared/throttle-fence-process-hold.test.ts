/**
 * Issue #873. A cooldown armed by a run that then failed kept its timer referenced, so the CLI
 * stayed alive for up to an hour after printing the error. `release_process_hold()` ends that hold
 * once the run is over, while a running workload keeps the reference that stops Node exiting 0 with
 * its callers still parked.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ThrottleFence } from '@/services/shared/throttle-fence';
import { InProcessThrottleCoordinator } from '@/services/shared/in-process-throttle-coordinator';

const ONE_HOUR_MS = 3_600_000;

interface FakeTimer {
  hasRef(): boolean;
}

let set_timeout: MockInstance<typeof setTimeout>;

/** Whether any timer created so far still keeps the process alive. */
function holds_process(): boolean {
  return set_timeout.mock.results.some((result) => (result.value as FakeTimer).hasRef());
}

beforeEach(() => {
  vi.useFakeTimers();
  set_timeout = vi.spyOn(globalThis, 'setTimeout');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ThrottleFence.release_process_hold', () => {
  let fence: ThrottleFence;

  beforeEach(() => {
    fence = new ThrottleFence();
  });

  afterEach(() => {
    fence.clear();
  });

  it('holds the process while a cooldown is armed and nothing has released it', () => {
    fence.raise(ONE_HOUR_MS / 1000);

    expect(holds_process()).toBe(true);
  });

  it('stops holding the process but keeps parked callers parked until the cooldown ends', async () => {
    fence.raise(ONE_HOUR_MS / 1000);
    let released = false;
    void fence.wait().then(() => {
      released = true;
    });

    fence.release_process_hold();
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS - 1);

    expect(holds_process()).toBe(false);
    expect(fence.is_raised).toBe(true);
    expect(released).toBe(false);

    await vi.advanceTimersByTimeAsync(5_001);
    expect(released).toBe(true);
  });

  it('does not hold the process for a cooldown raised after the hold was released', () => {
    fence.release_process_hold();
    fence.raise(60);

    expect(fence.is_raised).toBe(true);
    expect(holds_process()).toBe(false);
  });
});

describe('InProcessThrottleCoordinator.release_process_hold', () => {
  let coordinator: InProcessThrottleCoordinator;

  beforeEach(() => {
    coordinator = new InProcessThrottleCoordinator();
  });

  afterEach(() => {
    coordinator.clear();
  });

  it('releases every armed pool and owner fence without ending their cooldowns', () => {
    coordinator.raise('sharepoint_onedrive', ONE_HOUR_MS);
    coordinator.raise('outlook', ONE_HOUR_MS, { ownerId: 'mailbox-a' });

    coordinator.release_process_hold();

    expect(holds_process()).toBe(false);
    expect(coordinator.is_cooling('sharepoint_onedrive')).toBe(true);
    expect(coordinator.is_cooling('outlook', { ownerId: 'mailbox-a' })).toBe(true);
  });

  it('does not hold the process for a fence first created after the release', () => {
    coordinator.release_process_hold();
    coordinator.raise('teams', 60_000, { ownerId: 'team-a' });

    expect(coordinator.is_cooling('teams', { ownerId: 'team-a' })).toBe(true);
    expect(holds_process()).toBe(false);
  });
});
