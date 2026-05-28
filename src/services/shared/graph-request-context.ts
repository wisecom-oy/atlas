/**
 * AsyncLocalStorage-based context for Graph API request cost tracking.
 *
 * Each SDK method call creates a fresh GraphRequestCounter and runs the
 * underlying operation inside AsyncLocalStorage.run(). Connector decorators
 * use get_active_counter() to record each Graph request without any explicit
 * plumbing through service or use-case layers.
 *
 * This design ensures:
 *  - No global mutable state
 *  - No cross-job counter leaking even when AtlasInstance is reused
 *  - No modification required in service or domain code
 *  - CLI usage (no counter active) silently produces no cost data
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { GraphRequestCounter } from '@/services/shared/graph-request-counter';
import type { OperationCost } from '@/domain/graph-cost';

const _storage = new AsyncLocalStorage<GraphRequestCounter>();

/**
 * Runs `fn` inside a fresh cost-tracking context and returns both the result
 * and the accumulated OperationCost for the duration of the call.
 */
export async function run_with_cost_tracking<T>(fn: () => Promise<T>): Promise<[T, OperationCost]> {
  const counter = new GraphRequestCounter();
  const result = await _storage.run(counter, fn);
  return [result, counter.snapshot()];
}

/**
 * Returns the GraphRequestCounter active in the current async context, or
 * undefined if no cost-tracking context is active (e.g. CLI calls).
 */
export function get_active_counter(): GraphRequestCounter | undefined {
  return _storage.getStore();
}
