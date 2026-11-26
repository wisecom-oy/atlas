/**
 * Issue #859. A caller parked on the request window waits on a promise, which is not a libuv handle,
 * and only the slide timer resolves it. That timer was unref'd, so with no request in flight Node
 * exited 0 mid-run. The timer must hold the process while a caller is parked, and only then.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { SlidingWindowLimiter } from '@/services/shared/sliding-window-limiter';

const WINDOW_MS = 10_000;
const SLIDE_MS = 1_000;

interface FakeTimer {
  hasRef(): boolean;
}

let set_interval: MockInstance<typeof setInterval>;
let limiter: SlidingWindowLimiter;

/** Whether the limiter's slide timer keeps the process alive. */
function holds_process(): boolean {
  return (set_interval.mock.results[0]!.value as FakeTimer).hasRef();
}

/** Starts an acquire and reports whether it has resolved. */
function track(acquire: Promise<unknown>): { done: boolean } {
  const state = { done: false };
  void acquire.then(() => {
    state.done = true;
  });
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  set_interval = vi.spyOn(globalThis, 'setInterval');
  limiter = new SlidingWindowLimiter(WINDOW_MS, SLIDE_MS, 1);
});

afterEach(() => {
  limiter.shutdown();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SlidingWindowLimiter process hold', () => {
  it('does not hold the process while no caller is parked', async () => {
    await limiter.acquire(1);

    expect(holds_process()).toBe(false);
  });

  it('holds the process while a caller is parked, then lets go once it is granted', async () => {
    await limiter.acquire(1);
    const parked = track(limiter.acquire(1));
    await vi.advanceTimersByTimeAsync(0);

    expect(parked.done).toBe(false);
    expect(holds_process()).toBe(true);

    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(parked.done).toBe(true);
    expect(holds_process()).toBe(false);
  });

  it('keeps holding while a second caller is still parked behind the first', async () => {
    await limiter.acquire(1);
    const first = track(limiter.acquire(1));
    const second = track(limiter.acquire(1));

    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(first.done).toBe(true);
    expect(second.done).toBe(false);
    expect(holds_process()).toBe(true);
  });

  it('stops holding once released, but keeps the caller parked until tokens arrive', async () => {
    await limiter.acquire(1);
    const parked = track(limiter.acquire(1));

    limiter.release_process_hold();
    await vi.advanceTimersByTimeAsync(WINDOW_MS - SLIDE_MS);

    expect(holds_process()).toBe(false);
    expect(parked.done).toBe(false);

    await vi.advanceTimersByTimeAsync(SLIDE_MS);
    expect(parked.done).toBe(true);
  });

  it('does not hold the process for a caller parked after the hold was released', async () => {
    limiter.release_process_hold();
    await limiter.acquire(1);
    track(limiter.acquire(1));

    expect(holds_process()).toBe(false);
  });
});
