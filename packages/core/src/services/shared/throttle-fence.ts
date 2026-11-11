/**
 * Global throttle fence that blocks all Graph API requests when a 429 is received.
 *
 * When any request receives a 429 with Retry-After, it calls `raise(seconds)`.
 * All concurrent and future requests call `wait()` before proceeding.
 * Multiple `raise()` calls are non-additive -- the longest remaining duration wins.
 *
 * When the last timer expires, each parked caller resumes after its own random delay, bounded by
 * `cooldown_release_jitter_bound_ms` for the longest cooldown raised. Releasing them all in one
 * instant sent every request back to Graph at once and drew the next 429 (issue #641). `clear()`
 * releases callers at once, since it is for shutdown.
 *
 * Inspired by Corso's (alcionai/corso) timedFence.
 */

// Relative, like its siblings: m365-graph's tests load this file from source, where core's `@/` alias does not resolve.
import { cooldown_release_jitter_bound_ms } from './cooldown-release-jitter';

export class ThrottleFence {
  /** Resolves the fence with the bound of the release delay each parked caller draws, in ms. */
  private _resolve: ((jitter_bound_ms: number) => void) | undefined;
  private _promise: Promise<number> | undefined;
  private _timers = new Map<number, ReturnType<typeof setTimeout>>();
  private _next_id = 0;
  private _longest_ms = 0;

  /** Returns true when a fence is currently active. */
  get is_raised(): boolean {
    return this._promise !== undefined;
  }

  /**
   * Raises the fence for `seconds` duration. All `wait()` callers will block
   * until every active timer has expired. Non-additive: calling `raise(5)` then
   * `raise(1)` keeps the fence up for 5 seconds total, not 6.
   */
  raise(seconds: number): void {
    if (seconds <= 0) return;

    if (!this._promise) {
      this._promise = new Promise<number>((resolve) => {
        this._resolve = resolve;
      });
    }
    this._longest_ms = Math.max(this._longest_ms, seconds * 1000);

    const id = this._next_id++;
    const timer = setTimeout(() => {
      this._timers.delete(id);
      if (this._timers.size === 0) {
        this.dropFence(cooldown_release_jitter_bound_ms(this._longest_ms));
      }
    }, seconds * 1000);

    // Deliberately not unref'd. This timer is the only thing that will ever
    // release the callers parked in wait(), and an awaited promise is not a
    // libuv handle, so an unref'd timer lets Node exit 0 with the whole
    // workload still parked -- a truncated backup reported as a success.
    // Bounded by Retry-After, and clear() exists for shutdown.
    this._timers.set(id, timer);
  }

  /**
   * Blocks until the fence drops, then for a random share of the release jitter. Returns
   * immediately if no fence is active.
   */
  async wait(): Promise<void> {
    if (!this._promise) return;
    const jitter_bound_ms = await this._promise;
    if (jitter_bound_ms > 0) await delay(Math.random() * jitter_bound_ms);
  }

  /** Forces the fence down, releasing all blocked callers at once and clearing all timers. */
  clear(): void {
    for (const timer of this._timers.values()) {
      clearTimeout(timer);
    }
    this._timers.clear();
    this.dropFence(0);
  }

  private dropFence(jitter_bound_ms: number): void {
    if (this._resolve) {
      this._resolve(jitter_bound_ms);
    }
    this._resolve = undefined;
    this._promise = undefined;
    this._longest_ms = 0;
  }
}

/** Waits `ms`; the timer is not unref'd, for the same reason as the fence timer. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
