import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InProcessThrottleCoordinator } from '@/services/shared/in-process-throttle-coordinator';

describe('InProcessThrottleCoordinator', () => {
  let coordinator: InProcessThrottleCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    coordinator = new InProcessThrottleCoordinator();
  });

  afterEach(() => {
    coordinator.clear();
    vi.useRealTimers();
  });

  it('lets requests through when no cooldown was ever raised', async () => {
    await expect(coordinator.wait('sharepoint_onedrive')).resolves.toBeUndefined();
    expect(coordinator.is_cooling('sharepoint_onedrive')).toBe(false);
  });

  it('holds waiters on a pool until its cooldown ends', async () => {
    coordinator.raise('sharepoint_onedrive', 10_000);
    let released = false;
    void coordinator.wait('sharepoint_onedrive').then(() => (released = true));

    await vi.advanceTimersByTimeAsync(9_000);
    expect(released).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(released).toBe(true);
    expect(coordinator.is_cooling('sharepoint_onedrive')).toBe(false);
  });

  it('keeps pools independent, so a drive 429 does not pause Outlook', async () => {
    coordinator.raise('sharepoint_onedrive', 60_000);

    await expect(coordinator.wait('outlook')).resolves.toBeUndefined();
    expect(coordinator.is_cooling('outlook')).toBe(false);
    expect(coordinator.is_cooling('sharepoint_onedrive')).toBe(true);
  });

  it('never lets a shorter report shorten a longer cooldown', async () => {
    coordinator.raise('outlook', 30_000);
    coordinator.raise('outlook', 1_000);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(coordinator.is_cooling('outlook')).toBe(true);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(coordinator.is_cooling('outlook')).toBe(false);
  });

  it('releases every waiter on clear', async () => {
    coordinator.raise('identity', 60_000);
    const waiting = coordinator.wait('identity');

    coordinator.clear();

    await expect(waiting).resolves.toBeUndefined();
  });
});
