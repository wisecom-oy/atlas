/**
 * Sliding window rate limiter for Microsoft Graph API Exchange Online.
 *
 * Outlook service limit: 10,000 API requests per 10-minute window per app per mailbox.
 * Default capacity is 9,600 (96%) to leave breathing room.
 *
 * The slide timer holds the process open only while a caller is parked, since nothing else may be
 * left to wake it (issue #859). `release_process_hold()` ends that hold once the run has ended.
 *
 * Inspired by Corso's (alcionai/corso) sliding window implementation.
 *
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits
 */

import { GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-types';

const DEFAULT_WINDOW_MS = GRAPH_SERVICE_LIMITS.outlook.window_duration_ms;
const DEFAULT_SLIDE_INTERVAL_MS = 1_000;
const DEFAULT_CAPACITY = Math.floor(GRAPH_SERVICE_LIMITS.outlook.requests_per_window * 0.96);

/** Where `acquire` took its tokens from, so `refund` can return them to the same interval. */
export interface WindowGrant {
  readonly tokens: number;
  readonly interval: number;
  readonly epoch: number;
}

interface PendingAcquire {
  needed: number;
  resolve: (grant?: WindowGrant) => void;
}

export class SlidingWindowLimiter {
  private readonly _window_ms: number;
  private readonly _slide_ms: number;
  private readonly _capacity: number;
  private readonly _num_intervals: number;

  private _available: number;
  private _current_interval: number;
  /** Counts full turns of the window, so a refund can tell which turn its tokens were charged to. */
  private _epoch = 0;
  private _curr_counts: number[];
  private _prev_counts: number[];
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _queue: PendingAcquire[] = [];
  private _shut_down = false;
  private _holds_process = true;

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
    this.syncProcessHold();
  }

  /**
   * Acquires `n` tokens, blocking until they are available. Rejects as soon as `signal` fires and
   * takes the caller out of the queue, so a cancelled run neither waits for the window to slide nor
   * leaves tokens to be granted to nobody (issue #874).
   */
  async acquire(n = 1, signal?: AbortSignal): Promise<WindowGrant | undefined> {
    if (this._shut_down) throw new Error('SlidingWindowLimiter: already shut down');
    if (signal?.aborted) throw wait_cancelled_error(signal);
    if (n <= 0) return undefined;

    if (this._available >= n) return this.grantTokens(n);

    return new Promise<WindowGrant | undefined>((resolve, reject) => {
      const on_abort = (): void => {
        this.removePending(pending);
        reject(wait_cancelled_error(signal!));
      };
      const pending: PendingAcquire = {
        needed: n,
        resolve: (grant) => {
          signal?.removeEventListener('abort', on_abort);
          resolve(grant);
        },
      };
      this._queue.push(pending);
      signal?.addEventListener('abort', on_abort, { once: true });
      this.syncProcessHold();
    });
  }

  /**
   * Returns the tokens of a grant whose request was never sent, such as a caller cancelled while it
   * waited for a concurrency slot (issue #874). Tokens the window has already reclaimed by sliding
   * past their interval are not returned twice.
   */
  refund(grant: WindowGrant | undefined): void {
    if (grant === undefined || this._shut_down) return;
    const counts = this.counts_holding(grant);
    if (counts === undefined) return;
    const returned = Math.min(grant.tokens, counts[grant.interval]!);
    counts[grant.interval]! -= returned;
    this._available += returned;
    this.drainQueue();
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

  /**
   * Stops the slide timer from keeping the process alive, now and for callers parked later. Parked
   * callers stay parked until tokens slide back. For once the run that parked them has ended, so a
   * failed command exits with its result instead of after the window refills.
   */
  release_process_hold(): void {
    this._holds_process = false;
    this.syncProcessHold();
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

  private grantTokens(n: number): WindowGrant {
    this._available -= n;
    this._curr_counts[this._current_interval]! += n;
    return { tokens: n, interval: this._current_interval, epoch: this._epoch };
  }

  /**
   * The counts array still charging a grant: this turn's, or the previous turn's while the window
   * has not yet slid past the grant's interval. Undefined once its tokens were reclaimed.
   */
  private counts_holding(grant: WindowGrant): number[] | undefined {
    if (grant.epoch === this._epoch) return this._curr_counts;
    if (grant.epoch === this._epoch - 1 && grant.interval > this._current_interval) {
      return this._prev_counts;
    }
    return undefined;
  }

  private slideWindow(): void {
    this._current_interval = (this._current_interval + 1) % this._num_intervals;

    if (this._current_interval === 0) {
      this._epoch++;
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

  /** Drops a cancelled caller, then serves any caller its place in the queue was holding up. */
  private removePending(pending: PendingAcquire): void {
    const index = this._queue.indexOf(pending);
    if (index !== -1) this._queue.splice(index, 1);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this._queue.length > 0) {
      const head = this._queue[0]!;
      if (this._available < head.needed) break;
      this._queue.shift();
      head.resolve(this.grantTokens(head.needed));
    }
    this.syncProcessHold();
  }

  /**
   * Refs the slide timer while a caller is parked and unrefs it otherwise. A parked caller waits on
   * a promise, which is not a libuv handle, and with no Graph request in flight this timer is the
   * only thing left to wake it. Unref'd, Node exits 0 mid-run with nothing committed (issue #859).
   * Unref'd while idle, so a finished run whose limiter is never shut down still exits at once.
   */
  private syncProcessHold(): void {
    if (this._timer === undefined) return;
    if (this._holds_process && this._queue.length > 0) this._timer.ref();
    else this._timer.unref();
  }
}

/**
 * The error a wait cut short by `signal` rejects with: its reason when that is an Error, otherwise
 * an Error carrying the reason as `cause`. The Graph retry loop rejects its own waits the same way,
 * so a cancellation keeps its identity wherever it lands. Kept here rather than shared: a test runs
 * this file alone in a child Node process, where a sibling import without its extension fails.
 */
function wait_cancelled_error(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('The run was cancelled', { cause: reason });
}
