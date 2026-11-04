import { describe, expect, it } from 'vitest';
import {
  get_active_teams_request_stats,
  run_with_teams_request_stats,
  TeamsRequestStats,
} from '@/services/backup/teams-request-stats';

describe('TeamsRequestStats', () => {
  it('reports zero rates, not a division by zero, before any time has passed', () => {
    const stats = new TeamsRequestStats();
    stats.record_attempt('messages');

    expect(stats.snapshot(0).messages).toEqual({ requests: 1, throttled: 0, achieved_rps: 0 });
  });

  it('counts attempts and 429s per class and rounds the achieved rate to two decimals', () => {
    const stats = new TeamsRequestStats();
    for (let i = 0; i < 10; i++) stats.record_attempt('default');
    stats.record_throttled('default');
    stats.record_attempt('messages');

    const report = stats.snapshot(3000);

    expect(report.default).toEqual({ requests: 10, throttled: 1, achieved_rps: 3.33 });
    expect(report.messages).toEqual({ requests: 1, throttled: 0, achieved_rps: 0.33 });
  });

  it('is visible only inside the run that published it', async () => {
    const stats = new TeamsRequestStats();

    expect(get_active_teams_request_stats()).toBeUndefined();
    await run_with_teams_request_stats(stats, async () => {
      await Promise.resolve();
      expect(get_active_teams_request_stats()).toBe(stats);
    });
    expect(get_active_teams_request_stats()).toBeUndefined();
  });
});
