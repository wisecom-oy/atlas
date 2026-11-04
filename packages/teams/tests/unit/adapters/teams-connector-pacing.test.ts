import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get_active_request_pacing } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { pace_teams_connector } from '@/adapters/teams-connector-pacing';
import { TeamsRequestPacer, type TeamsPacingRates } from '@/adapters/teams-request-pacer';
import {
  run_with_teams_request_stats,
  TeamsRequestStats,
} from '@/services/backup/teams-request-stats';

/** A connector whose methods wait on the active pacing hook the way the Graph retry loop does. */
function fake_connector() {
  return {
    async list_messages(_tenant_id: string, _team_id: string, _channel_id: string) {
      await get_active_request_pacing()?.before_attempt(undefined);
      return 'messages';
    },
    async list_teams(_tenant_id: string) {
      await get_active_request_pacing()?.before_attempt(undefined);
      get_active_request_pacing()?.on_throttled();
      return 'teams';
    },
  };
}

function pacer_with(overrides: Partial<TeamsPacingRates>): TeamsRequestPacer {
  return new TeamsRequestPacer({
    tenant_messages_rps: Infinity,
    tenant_default_rps: Infinity,
    team_rps: Infinity,
    channel_rps: Infinity,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pace_teams_connector', () => {
  it('paces message calls on their channel lane, so a second call to a channel waits', async () => {
    const connector = pace_teams_connector(fake_connector(), pacer_with({ channel_rps: 1 }));
    const origin = Date.now();

    const first = connector.list_messages('t1', 'team-1', 'chan-1');
    const second = connector.list_messages('t1', 'team-1', 'chan-1').then(() => Date.now());
    await vi.advanceTimersByTimeAsync(2000);

    expect(await first).toBe('messages');
    expect((await second) - origin).toBe(1000);
  });

  it('counts each attempt and each 429 against the class of the call', async () => {
    const stats = new TeamsRequestStats();
    const connector = pace_teams_connector(fake_connector(), pacer_with({}));

    await run_with_teams_request_stats(stats, async () => {
      await connector.list_messages('t1', 'team-1', 'chan-1');
      await connector.list_teams('t1');
    });

    const report = stats.snapshot(1000);
    expect(report.messages).toMatchObject({ requests: 1, throttled: 0 });
    expect(report.default).toMatchObject({ requests: 1, throttled: 1 });
  });

  it('passes methods through unchanged when they are not functions', () => {
    const connector = pace_teams_connector({ base_url: 'https://graph.example' }, pacer_with({}));

    expect(connector.base_url).toBe('https://graph.example');
  });
});
