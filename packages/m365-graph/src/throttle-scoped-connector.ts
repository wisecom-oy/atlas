import type { GraphServicePool, ThrottleCoordinator } from '@wisecom/atlas-types';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';

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
): T {
  return new Proxy(inner, {
    get(target, property) {
      // Read against the target, not the proxy, so getters and private fields see their own object.
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        run_with_throttle_coordinator(coordinator, pool, () =>
          (value as (...a: unknown[]) => unknown).apply(target, args),
        );
    },
  });
}
