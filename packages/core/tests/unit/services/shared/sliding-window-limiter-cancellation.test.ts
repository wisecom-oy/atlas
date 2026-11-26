/**
 * Issue #874. An Outlook call parked on its mailbox's request window must stop waiting as soon as
 * the run is cancelled, stop holding the process, and leave the window to the callers behind it.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { SlidingWindowLimiter } from '@/services/shared/sliding-window-limiter';

const WINDOW_MS = 10_000;
const SLIDE_MS = 1_000;
const INTERRUPTED = new Error('Run interrupted by Ctrl+C');

interface FakeTimer {
  hasRef(): boolean;
}

let set_interval: MockInstance<typeof setInterval>;
let limiter: SlidingWindowLimiter;

/** Whether the limiter's slide timer keeps the process alive. */
function holds_process(): boolean {
  return (set_interval.mock.results[0]!.value as FakeTimer).hasRef();
}

beforeEach(() => {
  vi.useFakeTimers();
  set_interval = vi.spyOn(globalThis, 'setInterval');
  limiter = new SlidingWindowLimiter(WINDOW_MS, SLIDE_MS, 2);
});

afterEach(() => {
  limiter.shutdown();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SlidingWindowLimiter cancellation', () => {
  it('rejects a parked caller at once with the abort reason', async () => {
    await limiter.acquire(2);
    const controller = new AbortController();
    const parked = limiter.acquire(1, controller.signal);

    controller.abort(INTERRUPTED);

    await expect(parked).rejects.toBe(INTERRUPTED);
  });

  it('stops holding the process once its only parked caller is cancelled', async () => {
    await limiter.acquire(2);
    const controller = new AbortController();
    const parked = limiter.acquire(1, controller.signal);
    expect(holds_process()).toBe(true);

    controller.abort(INTERRUPTED);
    await parked.catch(() => undefined);

    expect(holds_process()).toBe(false);
  });

  it('serves the caller behind a cancelled one instead of granting tokens to nobody', async () => {
    // One token now and one a slide later, so the first returns alone.
    await limiter.acquire(1);
    await vi.advanceTimersByTimeAsync(SLIDE_MS);
    await limiter.acquire(1);
    const controller = new AbortController();
    const blocked_head = limiter.acquire(2, controller.signal);
    let next_done = false;
    void limiter.acquire(1).then(() => (next_done = true));
    await vi.advanceTimersByTimeAsync(WINDOW_MS - SLIDE_MS);
    expect(limiter.available).toBe(1);
    expect(next_done).toBe(false);

    controller.abort(INTERRUPTED);
    await blocked_head.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    expect(next_done).toBe(true);
    expect(limiter.available).toBe(0);
  });

  it('takes no tokens when the signal fired before the call', async () => {
    const controller = new AbortController();
    controller.abort(INTERRUPTED);

    await expect(limiter.acquire(1, controller.signal)).rejects.toBe(INTERRUPTED);
    expect(limiter.available).toBe(2);
  });

  it('still grants a parked caller whose run was not cancelled once tokens slide back', async () => {
    await limiter.acquire(2);
    const controller = new AbortController();
    let done = false;
    void limiter.acquire(1, controller.signal).then(() => (done = true));

    await vi.advanceTimersByTimeAsync(WINDOW_MS + SLIDE_MS);

    expect(done).toBe(true);
  });
});
