/**
 * Composes SlidingWindowLimiter + ConcurrencySemaphore into a single per-mailbox pacer. Each
 * mailbox gets its own sliding window and semaphore.
 *
 * Pacing only. The mailbox cooldown a 429 raises is waited out by the connector before it calls
 * `acquire`, because that wait counts against the call's retry budget and these do not (issue #884).
 */

import { SlidingWindowLimiter } from './sliding-window-limiter';
import { ConcurrencySemaphore } from './concurrency-semaphore';
import { GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-types';

const EXCHANGE_WINDOW_MS = GRAPH_SERVICE_LIMITS.outlook.window_duration_ms;
const EXCHANGE_SLIDE_MS = 1_000;
const EXCHANGE_CAPACITY = Math.floor(GRAPH_SERVICE_LIMITS.outlook.requests_per_window * 0.96);
const EXCHANGE_CONCURRENCY = GRAPH_SERVICE_LIMITS.outlook.max_concurrent_requests;

export interface MailboxRateLimiter {
  /**
   * Takes `cost` request-window tokens, then a concurrency slot. Rejects as soon as `signal` fires,
   * holding no slot, so a cancelled run stops waiting at once (issue #874).
   */
  acquire(cost?: number, signal?: AbortSignal): Promise<void>;
  release(): void;
  /** Stops a caller parked on the request window from keeping the process alive. */
  release_process_hold(): void;
  shutdown(): void;
}

export class DefaultMailboxRateLimiter implements MailboxRateLimiter {
  private readonly _window: SlidingWindowLimiter;
  private readonly _semaphore: ConcurrencySemaphore;

  constructor(window_capacity?: number, concurrency?: number) {
    this._window = new SlidingWindowLimiter(
      EXCHANGE_WINDOW_MS,
      EXCHANGE_SLIDE_MS,
      window_capacity ?? EXCHANGE_CAPACITY,
    );
    this._semaphore = new ConcurrencySemaphore(concurrency ?? EXCHANGE_CONCURRENCY);
  }

  /** Acquires window tokens, then a concurrency slot; either wait ends when `signal` fires. */
  async acquire(cost = 1, signal?: AbortSignal): Promise<void> {
    await this._window.acquire(cost, signal);
    await this._semaphore.acquire(signal);
  }

  /** Releases one concurrency slot. Must be called after the Graph request completes. */
  release(): void {
    this._semaphore.release();
  }

  /** Lets the process exit with callers still parked on the window; for once the run has ended. */
  release_process_hold(): void {
    this._window.release_process_hold();
  }

  /** Shuts down the sliding window timer. */
  shutdown(): void {
    this._window.shutdown();
  }
}

export interface MailboxRateLimiterFactory {
  create(): MailboxRateLimiter;
  /** Releases the process hold of every limiter, created now or later. */
  release_process_hold(): void;
  shutdown_all(): void;
}

export class DefaultMailboxRateLimiterFactory implements MailboxRateLimiterFactory {
  private readonly _window_capacity: number;
  private readonly _concurrency: number;
  private readonly _created: MailboxRateLimiter[] = [];
  private _holds_process = true;

  constructor(window_capacity?: number, concurrency?: number) {
    this._window_capacity = window_capacity ?? EXCHANGE_CAPACITY;
    this._concurrency = concurrency ?? EXCHANGE_CONCURRENCY;
  }

  /** Creates a new per-mailbox rate limiter. */
  create(): MailboxRateLimiter {
    const limiter = new DefaultMailboxRateLimiter(this._window_capacity, this._concurrency);
    if (!this._holds_process) limiter.release_process_hold();
    this._created.push(limiter);
    return limiter;
  }

  /**
   * Stops every limiter's window, created now or later, from keeping the process alive. For once
   * the run has ended; see {@link SlidingWindowLimiter.release_process_hold}.
   */
  release_process_hold(): void {
    this._holds_process = false;
    for (const limiter of this._created) limiter.release_process_hold();
  }

  /** Shuts down all created limiters. */
  shutdown_all(): void {
    for (const limiter of this._created) {
      limiter.shutdown();
    }
    this._created.length = 0;
  }
}
