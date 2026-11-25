import { AsyncLocalStorage } from 'node:async_hooks';
import { setMaxListeners } from 'node:events';
import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';

/** What a Graph call throws once it has spent its whole retry budget. */
export type GraphOutage = GraphUnavailableError | ThrottledError;

/**
 * Remembers the first Graph call of one backup run that spent its whole retry budget, and lets
 * every other call of that run see it.
 *
 * A budget is about 23.5 minutes of waiting, so a call that spends it has met a service incident,
 * not a fault of one item. Without the latch each later unit of the run (a message, a folder, a
 * channel, an event) started a fresh budget against the same incident, one after another, while
 * the run kept the owner's lease (issue #881).
 */
export class GraphOutageLatch {
  private readonly _controller = new AbortController();

  constructor() {
    // Every Graph call of the run listens while it waits, and a run issues them concurrently.
    setMaxListeners(0, this._controller.signal);
  }

  /** Fires when the latch trips. Its reason is the outage, so a wait cut short rejects with it. */
  get signal(): AbortSignal {
    return this._controller.signal;
  }

  /** The outage that tripped the latch, or undefined while none has. */
  get outage(): GraphOutage | undefined {
    const reason: unknown = this._controller.signal.reason;
    return is_graph_outage(reason) ? reason : undefined;
  }

  /** Records `outage` unless an earlier one is already recorded; the first one is kept. */
  trip(outage: GraphOutage): void {
    if (!this._controller.signal.aborted) this._controller.abort(outage);
  }
}

const _latch = new AsyncLocalStorage<GraphOutageLatch>();

/** True for the errors an exhausted retry budget becomes. */
export function is_graph_outage(err: unknown): err is GraphOutage {
  return err instanceof GraphUnavailableError || err instanceof ThrottledError;
}

/**
 * Records `err` on the current run's latch when it is an exhausted retry budget. Anything else, and
 * a call outside a backup run, records nothing.
 */
export function record_graph_outage(err: unknown): void {
  if (is_graph_outage(err)) _latch.getStore()?.trip(err);
}

/** The signal that fires once the current run has recorded an outage, or undefined outside a run. */
export function get_active_graph_outage_signal(): AbortSignal | undefined {
  return _latch.getStore()?.signal;
}

/**
 * Runs one backup under a fresh outage latch, and ends it with the outage once a Graph call inside
 * it spent its retry budget.
 *
 * After the latch trips, no Graph call of the run sends another request or starts another wait:
 * each throws the recorded outage. Units of work fail on it the way they fail on any Graph error,
 * so a failed folder, drive, calendar or channel keeps its previous checkpoint, and the run still
 * commits what it finished before the outage. The run then rejects with the outage, so the caller
 * sees `ATLAS_GRAPH_UNAVAILABLE` or `ATLAS_THROTTLED` rather than a partial result that hides it.
 *
 * A run whose `abort_signal` fired keeps its interrupted result: the operator stopped it, and that
 * is what it reports. A run that rejects on its own rejects with its own error.
 */
export async function run_stopping_on_graph_outage<T>(
  abort_signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const latch = new GraphOutageLatch();
  const result = await _latch.run(latch, run);
  const outage = latch.outage;
  if (outage !== undefined && abort_signal?.aborted !== true) throw outage;
  return result;
}
