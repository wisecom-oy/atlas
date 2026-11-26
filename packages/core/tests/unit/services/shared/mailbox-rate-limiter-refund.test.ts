/**
 * Issue #874. A caller cancelled while it waits for a concurrency slot never sends its request, so
 * the request-window tokens it already took go back to the window for the callers behind it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultMailboxRateLimiter } from '@/services/shared/mailbox-rate-limiter';
import { SlidingWindowLimiter } from '@/services/shared/sliding-window-limiter';

const WINDOW_MS = 10_000;
const SLIDE_MS = 1_000;
const INTERRUPTED = new Error('Run interrupted by Ctrl+C');

let limiters: { shutdown(): void }[] = [];

function track<T extends { shutdown(): void }>(limiter: T): T {
  limiters.push(limiter);
  return limiter;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const limiter of limiters) limiter.shutdown();
  limiters = [];
  vi.useRealTimers();
});

describe('DefaultMailboxRateLimiter refund on a cancelled slot wait', () => {
  it('returns the window tokens of a caller cancelled while waiting for a slot', async () => {
    // A window of 2 tokens and 1 slot: the first caller holds the slot, the second parks on it.
    const limiter = track(new DefaultMailboxRateLimiter(2, 1));
    await limiter.acquire();
    const controller = new AbortController();
    const parked = limiter.acquire(1, controller.signal).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort(INTERRUPTED);
    expect(await parked).toBe(INTERRUPTED);

    // The refunded token lets a third caller take the window at once after the slot frees.
    limiter.release();
    let third_done = false;
    void limiter.acquire().then(() => {
      third_done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(third_done).toBe(true);
  });
});

describe('SlidingWindowLimiter.refund', () => {
  it('returns tokens charged in the current turn of the window', async () => {
    const window = track(new SlidingWindowLimiter(WINDOW_MS, SLIDE_MS, 3));
    const grant = await window.acquire(2);
    expect(window.available).toBe(1);

    window.refund(grant);

    expect(window.available).toBe(3);
  });

  it('returns tokens charged in the previous turn that have not slid back yet', async () => {
    const window = track(new SlidingWindowLimiter(WINDOW_MS, SLIDE_MS, 3));
    await vi.advanceTimersByTimeAsync(5 * SLIDE_MS);
    const grant = await window.acquire(2);
    // Into the next turn, but before the window slides past the grant's interval.
    await vi.advanceTimersByTimeAsync(7 * SLIDE_MS);
    expect(window.available).toBe(1);

    window.refund(grant);

    expect(window.available).toBe(3);
  });

  it('does not return tokens twice once the window has reclaimed them', async () => {
    const window = track(new SlidingWindowLimiter(WINDOW_MS, SLIDE_MS, 3));
    const grant = await window.acquire(2);
    await vi.advanceTimersByTimeAsync(WINDOW_MS + SLIDE_MS);
    expect(window.available).toBe(3);

    window.refund(grant);

    expect(window.available).toBe(3);
  });

  it('ignores an empty grant', () => {
    const window = track(new SlidingWindowLimiter(WINDOW_MS, SLIDE_MS, 3));

    window.refund(undefined);

    expect(window.available).toBe(3);
  });
});
