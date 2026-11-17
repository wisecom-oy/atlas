import { describe, it, expect, afterEach, vi } from 'vitest';
import { ThrottleFence } from '@/services/shared/throttle-fence';

describe('ThrottleFence', () => {
  let fence: ThrottleFence;

  afterEach(() => {
    fence?.clear();
  });

  it('wait() resolves immediately when no fence is active', async () => {
    fence = new ThrottleFence();
    const start = Date.now();
    await fence.wait();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('wait() blocks until the fence duration expires', async () => {
    fence = new ThrottleFence();
    fence.raise(0.1);
    expect(fence.is_raised).toBe(true);

    const start = Date.now();
    await fence.wait();
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });

  it('multiple raise() calls use the longest remaining duration', async () => {
    fence = new ThrottleFence();
    fence.raise(0.2);
    fence.raise(0.05);

    const start = Date.now();
    await fence.wait();
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });

  it('clear() drops the fence immediately', async () => {
    fence = new ThrottleFence();
    fence.raise(10);

    let resolved = false;
    const waiter = fence.wait().then(() => {
      resolved = true;
    });

    fence.clear();
    await waiter;
    expect(resolved).toBe(true);
    expect(fence.is_raised).toBe(false);
  });

  it('raise(0) is a no-op', () => {
    fence = new ThrottleFence();
    fence.raise(0);
    expect(fence.is_raised).toBe(false);
  });

  it('raise(-1) is a no-op', () => {
    fence = new ThrottleFence();
    fence.raise(-1);
    expect(fence.is_raised).toBe(false);
  });

  /**
   * Issue #641. Releasing every parked caller in one instant sent the whole pool back to Graph at
   * once and drew the next 429. Each caller now resumes after its own delay, never before the
   * cooldown ends, bounded by a tenth of the cooldown (here 6 minutes, so the 5 second ceiling).
   */
  it('releases blocked callers at spread times after the cooldown, never before it', async () => {
    vi.useFakeTimers();
    try {
      fence = new ThrottleFence();
      fence.raise(360);
      const started = Date.now();

      const released_at: number[] = [];
      const waiters = Array.from({ length: 8 }, () =>
        fence.wait().then(() => released_at.push(Date.now() - started)),
      );
      await vi.advanceTimersByTimeAsync(360_000 - 1);
      expect(released_at).toEqual([]);

      await vi.advanceTimersByTimeAsync(5_001);
      await Promise.all(waiters);
      expect(released_at).toHaveLength(8);
      expect(Math.min(...released_at)).toBeGreaterThanOrEqual(360_000);
      expect(Math.max(...released_at)).toBeLessThanOrEqual(365_000);
      expect(new Set(released_at).size).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the release jitter by the longest cooldown raised', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      fence = new ThrottleFence();
      fence.raise(20);
      fence.raise(1);
      const started = Date.now();

      const waiter = fence.wait().then(() => Date.now() - started);
      await vi.advanceTimersByTimeAsync(25_000);

      // A tenth of 20 seconds is 2 seconds; the shorter raise does not shrink it.
      expect(await waiter).toBe(20_000 + Math.floor(0.999 * 2_000));
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('clear() releases blocked callers without the jitter', async () => {
    vi.useFakeTimers();
    try {
      fence = new ThrottleFence();
      fence.raise(360);
      let released = false;
      const waiter = fence.wait().then(() => {
        released = true;
      });

      fence.clear();
      await vi.advanceTimersByTimeAsync(0);
      expect(released).toBe(true);
      await waiter;
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Issue #196. An awaited promise is not a libuv handle, so if the only thing
   * keeping the loop alive is this timer and it is unref'd, Node exits 0 with
   * every caller still parked in wait(): a truncated backup that reports
   * success. Verified out of band, before the fix, with a script that raised a
   * fence, awaited wait() and exited at 0ms without ever resolving.
   */
  it('keeps the event loop alive while callers are parked', async () => {
    const real_set_timeout = globalThis.setTimeout;
    const unref_calls: number[] = [];

    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const timer = real_set_timeout(fn, ms);
      const real_unref = timer.unref.bind(timer);
      timer.unref = () => {
        unref_calls.push(ms ?? 0);
        return real_unref();
      };
      return timer;
    }) as typeof globalThis.setTimeout;

    try {
      fence = new ThrottleFence();
      fence.raise(0.05);
      await fence.wait();
    } finally {
      globalThis.setTimeout = real_set_timeout;
    }

    expect(unref_calls).toEqual([]);
  });
});
