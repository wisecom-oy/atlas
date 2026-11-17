import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scope_connector_throttling, with_graph_retry } from '@wisecom/atlas-m365-graph';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { team_id_of_call } from '@/adapters/teams-call-target';

/** A Graph 429 as the SDK delivers it, asking for a 10 second pause. */
function throttled_429(): Record<string, unknown> {
  return {
    statusCode: 429,
    message: 'Too Many Requests',
    headers: new Headers({ 'retry-after': '10' }),
  };
}

/** A Teams connector slice whose calls go through the real retry loop. */
function connector_over(
  coordinator: InProcessThrottleCoordinator,
  answer: (team: string) => Promise<string>,
) {
  const inner = {
    get_team: (_tenant: string, team_id: string) => with_graph_retry(() => answer(team_id)),
    list_teams: (_tenant: string) => with_graph_retry(() => answer('')),
  };
  return scope_connector_throttling(inner, coordinator, 'teams', { owner_of: team_id_of_call });
}

/** Resolves to the fake time at which `promise` settled. */
async function settled_at(promise: Promise<unknown>): Promise<number> {
  await promise;
  return Date.now();
}

describe('Teams throttle scope', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pauses only the throttled team, also for a second process sharing the coordinator', async () => {
    // One coordinator shared by two connectors stands in for a host coordinator shared by two processes.
    const shared = new InProcessThrottleCoordinator();
    let first_a = true;
    const process_1 = connector_over(shared, async (team) => {
      if (team === 'team-a' && first_a) {
        first_a = false;
        throw throttled_429();
      }
      return team;
    });
    const process_2 = connector_over(shared, async (team) => team);

    const start = Date.now();
    const a_retry = settled_at(process_1.get_team('tenant', 'team-a'));
    await vi.advanceTimersByTimeAsync(0);
    const b_elsewhere = settled_at(process_2.get_team('tenant', 'team-b'));
    const a_elsewhere = settled_at(process_2.get_team('tenant', 'team-a'));
    await vi.advanceTimersByTimeAsync(11_000);

    expect((await b_elsewhere) - start).toBeLessThan(1_000);
    expect((await a_elsewhere) - start).toBeGreaterThanOrEqual(10_000);
    expect((await a_retry) - start).toBeGreaterThanOrEqual(10_000);
    shared.clear();
  });

  it('pauses every team when a call with no team is throttled', async () => {
    const shared = new InProcessThrottleCoordinator();
    let first = true;
    const connector = connector_over(shared, async (team) => {
      if (team === '' && first) {
        first = false;
        throw throttled_429();
      }
      return team;
    });

    const start = Date.now();
    const listing = settled_at(connector.list_teams('tenant'));
    await vi.advanceTimersByTimeAsync(0);
    const team_b = settled_at(connector.get_team('tenant', 'team-b'));
    await vi.advanceTimersByTimeAsync(11_000);

    expect((await team_b) - start).toBeGreaterThanOrEqual(10_000);
    await listing;
    shared.clear();
  });
});
