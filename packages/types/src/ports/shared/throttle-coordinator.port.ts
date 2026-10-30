import type { GraphServicePool } from '@/domain/graph-cost';

/**
 * Coordinates Microsoft Graph throttling across every operation that shares it.
 *
 * Atlas calls `wait` before each HTTP attempt to Graph and `raise` whenever Graph answers 429, both
 * keyed by the throttling pool the request is charged to. The default keeps one cooldown per pool
 * in memory, so a 429 on one operation pauses the instance's other operations on the same pool.
 * A host running several operations for one tenant across processes can supply its own
 * implementation backed by shared state, so a 429 seen by one process pauses the others too.
 *
 * A host-supplied coordinator fails open. If `wait` rejects, the request is sent anyway, and if
 * `raise` throws or returns a rejected promise, the failure is logged and the retry loop keeps its
 * own Retry-After backoff. An outage in the shared state therefore costs coordination, never the
 * operation.
 */
export interface ThrottleCoordinator {
  /**
   * Resolves once requests to `pool` may be sent. Called before every attempt, including retries,
   * so it should answer from local state and stay cheap when no cooldown is active.
   */
  wait(pool: GraphServicePool): Promise<void>;

  /**
   * Reports that Graph throttled a request to `pool` and asked for `retry_after_ms` before the next.
   * Cooldowns are not additive: a shorter report never shortens a longer one already in force.
   */
  raise(pool: GraphServicePool, retry_after_ms: number): void;
}
