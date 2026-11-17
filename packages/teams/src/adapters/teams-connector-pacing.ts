import {
  run_with_request_pacing,
  type RequestPacing,
} from '@wisecom/atlas-core/services/shared/graph-request-context';
import { channel_id_of_call, team_id_of_call } from '@/adapters/teams-call-target';
import type { TeamsRequestPacer } from '@/adapters/teams-request-pacer';
import {
  get_active_teams_request_stats,
  type TeamsRequestClass,
} from '@/services/backup/teams-request-stats';

/** Connector methods that read messages, replies, or hosted content, which Graph meters apart. */
const MESSAGE_METHOD = /message|repl|hosted/i;

/**
 * Wraps every method of a Teams connector so each Graph attempt it makes waits for its pacing slots
 * and counts toward the run's request stats. The wrapper publishes a pacing hook for the call; the
 * retry loop runs the hook before every attempt, retries included, and reports each 429 to it.
 *
 * A Proxy for the same reason as `scope_connector_throttling`: the connector port is wide and the
 * wrapping is identical for every method. The first argument of every method is the tenant id.
 */
export function pace_teams_connector<T extends object>(inner: T, pacer: TeamsRequestPacer): T {
  return new Proxy(inner, {
    get(target, property) {
      // Read against the target, not the proxy, so getters and private fields see their own object.
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      const request_class: TeamsRequestClass = MESSAGE_METHOD.test(String(property))
        ? 'messages'
        : 'default';
      return (...args: unknown[]) => {
        const pacing = pacing_for_call(pacer, request_class, args);
        return run_with_request_pacing(pacing, () =>
          (value as (...a: unknown[]) => unknown).apply(target, args),
        );
      };
    },
  });
}

/** The pacing hook for one connector call. Stats are read now, while the run context is active. */
function pacing_for_call(
  pacer: TeamsRequestPacer,
  request_class: TeamsRequestClass,
  args: readonly unknown[],
): RequestPacing {
  const stats = get_active_teams_request_stats();
  const request = {
    request_class,
    tenant_id: String(args[0]),
    team_id: team_id_of_call(args),
    channel_id: channel_id_of_call(args),
  };
  return {
    async before_attempt(signal) {
      await pacer.acquire(request, signal);
      stats?.record_attempt(request_class);
    },
    on_throttled() {
      stats?.record_throttled(request_class);
    },
  };
}
