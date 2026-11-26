/**
 * Runs tasks with at most `limit` in flight. `add` waits while the pool is full, so a producer
 * that builds each task's input lazily never holds more than `limit` inputs at once.
 *
 * The first failure stops the pool: later `add` calls and `drain` raise it once every task still
 * in flight has settled, so nothing keeps writing after the caller has given up.
 */
export class BoundedTaskPool {
  private readonly _in_flight = new Set<Promise<void>>();
  private _failure: { readonly error: unknown } | undefined;

  constructor(private readonly _limit: number) {}

  /** Starts the task once a slot is free; raises the pool's first failure instead of starting it. */
  async add(task: () => Promise<void>): Promise<void> {
    while (this._in_flight.size >= this._limit && this._failure === undefined) {
      await Promise.race(this._in_flight);
    }
    if (this._failure !== undefined) return this.drain();
    const running = task().catch((err: unknown) => {
      this._failure ??= { error: err };
    });
    const tracked = running.finally(() => this._in_flight.delete(tracked));
    this._in_flight.add(tracked);
  }

  /** Waits for every task in flight, then raises the first failure if there was one. */
  async drain(): Promise<void> {
    await Promise.all(this._in_flight);
    if (this._failure !== undefined) throw this._failure.error;
  }
}
