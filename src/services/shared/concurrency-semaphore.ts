/**
 * Promise-based semaphore for limiting concurrent in-flight operations.
 *
 * Outlook service limit: 4 concurrent requests per app per mailbox.
 */

const DEFAULT_CONCURRENCY = 4;

export class ConcurrencySemaphore {
  private _available: number;
  private readonly _capacity: number;
  private readonly _queue: (() => void)[] = [];

  constructor(capacity = DEFAULT_CONCURRENCY) {
    if (capacity < 1) throw new Error('ConcurrencySemaphore: capacity must be >= 1');
    this._capacity = capacity;
    this._available = capacity;
  }

  /** Acquires one slot. Resolves immediately if a slot is free, otherwise waits. */
  async acquire(): Promise<void> {
    if (this._available > 0) {
      this._available--;
      return;
    }

    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  /** Releases one slot, waking the next waiter if any. */
  release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._available = Math.min(this._available + 1, this._capacity);
    }
  }

  /** Number of slots currently available. */
  get available(): number {
    return this._available;
  }

  /** Number of callers waiting in the queue. */
  get waiting(): number {
    return this._queue.length;
  }

  /** Configured capacity. */
  get capacity(): number {
    return this._capacity;
  }
}
