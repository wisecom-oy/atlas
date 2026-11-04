import type { GraphServicePool } from '@/domain/graph/cost';

/**
 * Narrows a throttle cooldown below its pool. Graph meters Outlook per mailbox per application and
 * Teams per team, so a 429 on one mailbox or team says nothing about another; the other pools are
 * metered per tenant and carry no scope.
 */
export interface ThrottleScope {
  /** Normalized owner id (mailbox object id or address, or team id, lowercased) for the `outlook` and `teams` pools. */
  readonly ownerId?: string;
}

/**
 * Coordinates Microsoft Graph throttling across every operation that shares it.
 *
 * Atlas calls `wait` before each HTTP attempt to Graph and `raise` whenever Graph answers 429, both
 * keyed by the throttling pool the request is charged to and, for Outlook requests, the mailbox it
 * targets. The default keeps one cooldown per pool in memory, and one per mailbox for `outlook`, so
 * a 429 on one mailbox pauses only that mailbox. A host running several operations for one tenant
 * across processes can supply its own implementation backed by shared state, so a 429 seen by one
 * process pauses the others too.
 *
 * A coordinator written against the 6.1 two-argument signature keeps working: the scope is an
 * extra argument it may ignore, which pauses every mailbox on the pool instead of one.
 *
 * A host-supplied coordinator fails open. If `wait` rejects, the request is sent anyway, and if
 * `raise` throws or returns a rejected promise, the failure is logged and the retry loop keeps its
 * own Retry-After backoff. An outage in the shared state therefore costs coordination, never the
 * operation.
 */
export interface ThrottleCoordinator {
  /**
   * Resolves once requests to `pool` (and `scope`, when given) may be sent. Called before every
   * attempt, including retries, so it should answer from local state and stay cheap when no
   * cooldown is active.
   */
  wait(pool: GraphServicePool, scope?: ThrottleScope): Promise<void>;

  /**
   * Reports that Graph throttled a request to `pool` (and `scope`, when given) and asked for
   * `retry_after_ms` before the next. Cooldowns are not additive: a shorter report never shortens a
   * longer one already in force.
   */
  raise(pool: GraphServicePool, retry_after_ms: number, scope?: ThrottleScope): void;
}
