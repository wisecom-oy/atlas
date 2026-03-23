/**
 * Sliding window rate limiter for Microsoft Graph API Exchange Online.
 *
 * Outlook service limit: 10,000 API requests per 10-minute window per app per mailbox.
 * Default capacity is 9,600 (96%) to leave breathing room.
 *
 * Inspired by Corso's (alcionai/corso) sliding window implementation.
 */

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SLIDE_INTERVAL_MS = 1_000;
const DEFAULT_CAPACITY = 9_600;

interface PendingAcquire {
  needed: number;
  resolve: () => void;
}

export class SlidingWindowLimiter {
  private readonly _window_ms: number;
  private readonly _slide_ms: number;
  private readonly _capacity: number;
  private readonly _num_intervals: number;

  private _available: number;
  private _current_interval: number;
  private _curr_counts: number[];
  private _prev_counts: number[];
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _queue: PendingAcquire[] = [];
  private _shut_down = false;

  constructor(
    window_ms = DEFAULT_WINDOW_MS,
    slide_interval_ms = DEFAULT_SLIDE_INTERVAL_MS,
    capacity = DEFAULT_CAPACITY,
  ) {
    if (window_ms <= 0 || slide_interval_ms <= 0 || capacity < 0) {
      throw new Error('SlidingWindowLimiter: invalid configuration');
    }
    if (window_ms < slide_interval_ms || window_ms % slide_interval_ms !== 0) {
      throw new Error('SlidingWindowLimiter: window must be a positive multiple of slide interval');
    }

    this._window_ms = window_ms;
    this._slide_ms = slide_interval_ms;
    this._capacity = capacity;
    this._num_intervals = window_ms / slide_interval_ms;
    this._available = capacity;
    this._current_interval = 0;
    this._curr_counts = new Array<number>(this._num_intervals).fill(0);
    this._prev_counts = new Array<number>(this._num_intervals).fill(0);

    this._timer = setInterval(() => this.slideWindow(), this._slide_ms);
    if (this._timer.unref) this._timer.unref();
  }

  /** Acquires `n` tokens, blocking until they are available. */
  async acquire(n = 1): Promise<void> {
    if (this._shut_down) throw new Error('SlidingWindowLimiter: already shut down');
    if (n <= 0) return;

    if (this._available >= n) {
      this.grantTokens(n);
      return;
    }

    return new Promise<void>((resolve) => {
      this._queue.push({ needed: n, resolve });
    });
  }

  /** Returns the number of currently available tokens. */
  get available(): number {
    return this._available;
  }

  /** Returns the configured capacity. */
  get capacity(): number {
    return this._capacity;
  }

  /** Resets all counts and restores tokens to full capacity. */
  reset(): void {
    this._curr_counts.fill(0);
    this._prev_counts.fill(0);
    this._available = this._capacity;
    this.drainQueue();
  }

  /** Stops the slide timer. The limiter cannot be used after shutdown. */
  shutdown(): void {
    if (this._shut_down) return;
    this._shut_down = true;
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
    for (const pending of this._queue) {
      pending.resolve();
    }
    this._queue = [];
  }

  private grantTokens(n: number): void {
    this._available -= n;
    this._curr_counts[this._current_interval]! += n;
  }

  private slideWindow(): void {
    this._current_interval = (this._current_interval + 1) % this._num_intervals;

    if (this._current_interval === 0) {
      this._prev_counts = [...this._curr_counts];
      this._curr_counts.fill(0);
    }

    const reclaimed = this._prev_counts[this._current_interval]!;
    if (reclaimed > 0) {
      this._available += reclaimed;
      this._prev_counts[this._current_interval] = 0;
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    while (this._queue.length > 0) {
      const head = this._queue[0]!;
      if (this._available < head.needed) break;
      this._queue.shift();
      this.grantTokens(head.needed);
      head.resolve();
    }
  }
}
