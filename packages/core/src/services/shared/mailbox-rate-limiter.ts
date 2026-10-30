/**
 * Composes SlidingWindowLimiter + ConcurrencySemaphore + the Outlook pool's
 * throttle cooldown into a single per-mailbox rate limiter. Each mailbox gets
 * its own sliding window and semaphore, but they all wait on the same
 * ThrottleCoordinator, so a 429 on one mailbox pauses the others.
 */

import { SlidingWindowLimiter } from './sliding-window-limiter';
import { ConcurrencySemaphore } from './concurrency-semaphore';
import { GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-types';
import type { ThrottleCoordinator } from '@wisecom/atlas-types';

const EXCHANGE_WINDOW_MS = GRAPH_SERVICE_LIMITS.outlook.window_duration_ms;
const EXCHANGE_SLIDE_MS = 1_000;
const EXCHANGE_CAPACITY = Math.floor(GRAPH_SERVICE_LIMITS.outlook.requests_per_window * 0.96);
const EXCHANGE_CONCURRENCY = GRAPH_SERVICE_LIMITS.outlook.max_concurrent_requests;

export interface MailboxRateLimiter {
  acquire(cost?: number): Promise<void>;
  release(): void;
  shutdown(): void;
}

export class DefaultMailboxRateLimiter implements MailboxRateLimiter {
  private readonly _window: SlidingWindowLimiter;
  private readonly _semaphore: ConcurrencySemaphore;
  private readonly _throttle: ThrottleCoordinator;

  constructor(throttle: ThrottleCoordinator, window_capacity?: number, concurrency?: number) {
    this._window = new SlidingWindowLimiter(
      EXCHANGE_WINDOW_MS,
      EXCHANGE_SLIDE_MS,
      window_capacity ?? EXCHANGE_CAPACITY,
    );
    this._semaphore = new ConcurrencySemaphore(concurrency ?? EXCHANGE_CONCURRENCY);
    this._throttle = throttle;
  }

  /** Waits out any Outlook cooldown, acquires rate window tokens, then a concurrency slot. */
  async acquire(cost = 1): Promise<void> {
    await this._throttle.wait('outlook');
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
  private readonly _throttle: ThrottleCoordinator;
  private readonly _window_capacity: number;
  private readonly _concurrency: number;
  private readonly _created: MailboxRateLimiter[] = [];

  constructor(throttle: ThrottleCoordinator, window_capacity?: number, concurrency?: number) {
    this._throttle = throttle;
    this._window_capacity = window_capacity ?? EXCHANGE_CAPACITY;
    this._concurrency = concurrency ?? EXCHANGE_CONCURRENCY;
  }

  /** Creates a new per-mailbox rate limiter sharing the coordinator. */
  create(): MailboxRateLimiter {
    const limiter = new DefaultMailboxRateLimiter(
      this._throttle,
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
