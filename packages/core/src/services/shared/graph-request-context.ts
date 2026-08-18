/**
 * AsyncLocalStorage-based context for Graph API request cost tracking.
 *
 * Each SDK method call creates a fresh GraphRequestCounter and runs the
 * underlying operation inside AsyncLocalStorage.run(). A transport middleware
 * records one entry per HTTP request actually sent, so pagination and retries
 * are counted; connector methods declare what they are doing with
 * run_with_graph_operation() so those requests carry a pool and a label.
 *
 * CLI calls (no counter active) silently produce no cost data.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { GraphRequestCounter } from './graph-request-counter';
import type { GraphOperation, OperationCost } from '@wisecom/atlas-types';

const _storage = new AsyncLocalStorage<GraphRequestCounter>();
const _operation = new AsyncLocalStorage<GraphOperation>();

/**
 * Runs `fn` inside a fresh cost-tracking context and returns both the result
 * and the accumulated OperationCost for the duration of the call.
 *
 * When `fn` rejects, the cost burned before the failure is attached to the
 * thrown error and readable with {@link get_graph_cost}. Failures are the most
 * expensive runs a tenant pays for -- a delta sync that dies on page 400, or a
 * request that spent its whole retry budget against a 429 -- so a scheduler
 * that only reads cost on success re-queues straight into a throttled tenant.
 * The original error is rethrown unchanged, so `instanceof` checks and catch
 * filters on the caller's side keep working.
 */
export async function run_with_cost_tracking<T>(fn: () => Promise<T>): Promise<[T, OperationCost]> {
  const counter = new GraphRequestCounter();
  try {
    const result = await _storage.run(counter, fn);
    return [result, counter.snapshot()];
  } catch (err) {
    attach_graph_cost(err, counter.snapshot());
    throw err;
  }
}

/**
 * Records `cost` on a thrown value. Non-enumerable, so error logging and
 * serialisation are unchanged; skipped for primitives and non-extensible
 * objects, which cannot carry it.
 */
function attach_graph_cost(err: unknown, cost: OperationCost): void {
  if (typeof err !== 'object' || err === null || !Object.isExtensible(err)) return;
  Object.defineProperty(err, 'graph_cost', {
    value: cost,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/**
 * Graph cost burned before `err` was thrown out of a tracked operation, or
 * undefined when the error did not come from one. Nested contexts each attach
 * their own; the value read here is the outermost, i.e. the cost of the call
 * the caller actually made.
 */
export function get_graph_cost(err: unknown): OperationCost | undefined {
  if (typeof err !== 'object' || err === null || !('graph_cost' in err)) return undefined;
  const cost = err.graph_cost;
  return is_operation_cost(cost) ? cost : undefined;
}

/** Checks that an attached value really is a cost snapshot before handing it out. */
function is_operation_cost(value: unknown): value is OperationCost {
  return (
    typeof value === 'object' &&
    value !== null &&
    'requests_total' in value &&
    typeof value.requests_total === 'number'
  );
}

/**
 * Returns the GraphRequestCounter active in the current async context, or
 * undefined if no cost-tracking context is active (e.g. CLI calls).
 */
export function get_active_counter(): GraphRequestCounter | undefined {
  return _storage.getStore();
}

/**
 * Declares what the Graph requests issued inside `fn` are for, so the transport
 * can charge each one to the right pool under a stable label.
 *
 * Scoped rather than recorded: one connector method can issue any number of
 * requests (continuation pages, retried attempts), and all of them belong to
 * this operation. Nested scopes shadow, so an inner declaration wins for the
 * requests it makes.
 */
export function run_with_graph_operation<T>(
  operation: GraphOperation,
  fn: () => Promise<T>,
): Promise<T> {
  return _operation.run(operation, fn);
}

/** The operation the current async context is inside, if any. */
export function get_active_operation(): GraphOperation | undefined {
  return _operation.getStore();
}
