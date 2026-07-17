/**
 * Minimal external store consumed by Ink views through `useSyncExternalStore`.
 * Port-implementing dashboard stores extend this to translate imperative
 * reporter calls from services into immutable state snapshots.
 */
export class DashboardStore<State extends object> {
  private _state: State;
  private readonly _listeners = new Set<() => void>();

  constructor(initial_state: State) {
    this._state = initial_state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };

  get_snapshot = (): State => this._state;

  /** Applies a mutation to a fresh top-level snapshot and notifies subscribers. */
  protected update(mutate: (draft: State) => void): void {
    this._state = { ...this._state };
    mutate(this._state);
    for (const listener of this._listeners) listener();
  }
}
