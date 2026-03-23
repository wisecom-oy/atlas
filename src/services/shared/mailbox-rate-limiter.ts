/**
 * Composes SlidingWindowLimiter + ConcurrencySemaphore + ThrottleFence into
 * a single per-mailbox rate limiter. Each mailbox gets its own sliding window
 * and semaphore, but they all share the same global throttle fence.
 */

import { SlidingWindowLimiter } from '@/services/shared/sliding-window-limiter';
import { ConcurrencySemaphore } from '@/services/shared/concurrency-semaphore';
import type { ThrottleFence } from '@/services/shared/throttle-fence';

const EXCHANGE_WINDOW_MS = 10 * 60 * 1000;
const EXCHANGE_SLIDE_MS = 1_000;
const EXCHANGE_CAPACITY = 9_600;
const EXCHANGE_CONCURRENCY = 4;

export interface MailboxRateLimiter {
  acquire(cost?: number): Promise<void>;
  release(): void;
  shutdown(): void;
}

export class DefaultMailboxRateLimiter implements MailboxRateLimiter {
  private readonly _window: SlidingWindowLimiter;
  private readonly _semaphore: ConcurrencySemaphore;
  private readonly _fence: ThrottleFence;

  constructor(fence: ThrottleFence, window_capacity?: number, concurrency?: number) {
    this._window = new SlidingWindowLimiter(
      EXCHANGE_WINDOW_MS,
      EXCHANGE_SLIDE_MS,
      window_capacity ?? EXCHANGE_CAPACITY,
    );
    this._semaphore = new ConcurrencySemaphore(concurrency ?? EXCHANGE_CONCURRENCY);
    this._fence = fence;
  }

  /** Waits for the global fence, acquires rate window tokens, then a concurrency slot. */
  async acquire(cost = 1): Promise<void> {
    await this._fence.wait();
    await this._window.acquire(cost);
    await this._semaphore.acquire();
  }

  /** Releases one concurrency slot. Must be called after the Graph request completes. */
  release(): void {
    this._semaphore.release();
  }

  /** Shuts down the sliding window timer. */
  shutdown(): void {
    this._window.shutdown();
  }
}

export interface MailboxRateLimiterFactory {
  create(): MailboxRateLimiter;
  shutdown_all(): void;
}

export class DefaultMailboxRateLimiterFactory implements MailboxRateLimiterFactory {
  private readonly _fence: ThrottleFence;
  private readonly _window_capacity: number;
  private readonly _concurrency: number;
  private readonly _created: MailboxRateLimiter[] = [];

  constructor(fence: ThrottleFence, window_capacity?: number, concurrency?: number) {
    this._fence = fence;
    this._window_capacity = window_capacity ?? EXCHANGE_CAPACITY;
    this._concurrency = concurrency ?? EXCHANGE_CONCURRENCY;
  }

  /** Creates a new per-mailbox rate limiter sharing the global fence. */
  create(): MailboxRateLimiter {
    const limiter = new DefaultMailboxRateLimiter(
      this._fence,
      this._window_capacity,
      this._concurrency,
    );
    this._created.push(limiter);
    return limiter;
  }

  /** Shuts down all created limiters. */
  shutdown_all(): void {
    for (const limiter of this._created) {
      limiter.shutdown();
    }
    this._created.length = 0;
  }
}
