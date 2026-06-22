/**
 * Global throttle fence that blocks all Graph API requests when a 429 is received.
 *
 * When any request receives a 429 with Retry-After, it calls `raise(seconds)`.
 * All concurrent and future requests call `wait()` before proceeding.
 * Multiple `raise()` calls are non-additive -- the longest remaining duration wins.
 * All blocked callers are released simultaneously when the last timer expires.
 *
 * Inspired by Corso's (alcionai/corso) timedFence.
 */

export class ThrottleFence {
  private _resolve: (() => void) | undefined;
  private _promise: Promise<void> | undefined;
  private _timers = new Map<number, ReturnType<typeof setTimeout>>();
  private _next_id = 0;

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
      this._promise = new Promise<void>((resolve) => {
        this._resolve = resolve;
      });
    }

    const id = this._next_id++;
    const timer = setTimeout(() => {
      this._timers.delete(id);
      if (this._timers.size === 0) {
        this.dropFence();
      }
    }, seconds * 1000);

    if (timer.unref) timer.unref();
    this._timers.set(id, timer);
  }

  /** Blocks until the fence drops. Returns immediately if no fence is active. */
  async wait(): Promise<void> {
    if (this._promise) {
      await this._promise;
    }
  }

  /** Forces the fence down, releasing all blocked callers and clearing all timers. */
  clear(): void {
    for (const timer of this._timers.values()) {
      clearTimeout(timer);
    }
    this._timers.clear();
    this.dropFence();
  }

  private dropFence(): void {
    if (this._resolve) {
      this._resolve();
    }
    this._resolve = undefined;
    this._promise = undefined;
  }
}
