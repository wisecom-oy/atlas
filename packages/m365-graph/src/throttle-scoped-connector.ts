import type { GraphServicePool, ThrottleCoordinator } from '@wisecom/atlas-types';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';

/** How a scoped connector finds the mailbox a call targets. */
export interface ThrottleScopeOptions {
  /**
   * Index of the argument that carries the mailbox owner id. Outlook requests are then throttled
   * per mailbox; omit it for connectors whose requests are not owner-scoped.
   */
  readonly owner_argument?: number;
}

/**
 * Wraps every method of a Graph connector so the calls it makes run under `coordinator`, charged to
 * `pool` unless a request declares its own.
 *
 * The retry loop consults whichever coordinator is ambient on each attempt and reports each 429 to
 * it. Without this wrapper the OneDrive and SharePoint connectors ran with none, so a 429 on one
 * drive request slowed only that request while every other one kept firing into the same tenant
 * budget (#551).
 *
 * A Proxy rather than a hand-written decorator because the connector ports are wide and the
 * wrapping is identical for every method. Non-function properties pass through untouched.
 */
export function scope_connector_throttling<T extends object>(
  inner: T,
  coordinator: ThrottleCoordinator,
  pool: GraphServicePool,
  options: ThrottleScopeOptions = {},
): T {
  return new Proxy(inner, {
    get(target, property) {
      // Read against the target, not the proxy, so getters and private fields see their own object.
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const owner: unknown =
          options.owner_argument === undefined ? undefined : args[options.owner_argument];
        const scope =
          typeof owner === 'string' ? { ownerId: normalize_owner_id(owner) } : undefined;
        return run_with_throttle_coordinator(
          coordinator,
          pool,
          () => (value as (...a: unknown[]) => unknown).apply(target, args),
          scope,
        );
      };
    },
  });
}
