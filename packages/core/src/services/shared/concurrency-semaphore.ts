/**
 * Promise-based semaphore for limiting concurrent in-flight operations.
 *
 * Outlook service limit: 4 concurrent requests per app per mailbox.
 *
 * Needs no timer to hold the process open: a caller waits only while every slot is taken, and each
 * holder's request, retry timer, or cooldown keeps Node alive until it calls `release()`.
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

  /**
   * Acquires one slot. Resolves immediately if a slot is free, otherwise waits. Rejects as soon as
   * `signal` fires, leaving the queue without its waiter, so a cancelled caller never holds a slot
   * it will not release (issue #874).
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw wait_cancelled_error(signal);
    if (this._available > 0) {
      this._available--;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const on_abort = (): void => {
        this.remove_waiter(waiter);
        reject(wait_cancelled_error(signal!));
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', on_abort);
        resolve();
      };
      this._queue.push(waiter);
      signal?.addEventListener('abort', on_abort, { once: true });
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

  private remove_waiter(waiter: () => void): void {
    const index = this._queue.indexOf(waiter);
    if (index !== -1) this._queue.splice(index, 1);
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

/**
 * The error a wait cut short by `signal` rejects with: its reason when that is an Error, otherwise
 * an Error carrying the reason as `cause`. The Graph retry loop rejects its own waits the same way,
 * so a cancellation keeps its identity wherever it lands.
 */
function wait_cancelled_error(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('The run was cancelled', { cause: reason });
}
