/**
 * Runs tasks that share a key one after another, in the order they arrive, and tasks with different
 * keys side by side. Atlas uses it to make a checked write (read the condition, then write) atomic
 * within one process, which a backend without conditional writes cannot do for it (issue #974).
 */
export class KeyedWriteSerializer {
  /** The promise the next task under each key waits for. It never rejects. */
  private readonly _tails = new Map<string, Promise<void>>();

  /** Runs `task` once every earlier task under `key` has settled, and returns its result. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this._tails.get(key) ?? Promise.resolve();
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const tail = previous.then(() => done);
    this._tails.set(key, tail);
    try {
      await previous;
      return await task();
    } finally {
      settle();
      if (this._tails.get(key) === tail) this._tails.delete(key);
    }
  }
}
