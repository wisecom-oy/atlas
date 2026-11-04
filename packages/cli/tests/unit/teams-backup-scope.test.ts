import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from 'inversify';
import { execute_teams_backup } from '@/commands/teams-command.handlers';
import {
  AuthError,
  TEAMS_BACKUP_USE_CASE_TOKEN,
  TEAMS_CATALOG_USE_CASE_TOKEN,
  type TeamsBackupUseCase,
  type TeamsBackupResult,
  type TeamsCatalogUseCase,
} from '@wisecom/atlas-types';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const TENANT = 'tenant-example';

function healthy_result(team_id: string): TeamsBackupResult {
  return {
    team_id,
    snapshot: undefined,
    interrupted: false,
    summary: {
      healthy: true,
      channels_scanned: 0,
      channels_full_read: 0,
      threads_changed: 0,
      messages_stored: 0,
      messages_deduplicated: 0,
      threads_deleted: 0,
      hosted_content_stored: 0,
      cursor_updated: false,
      snapshot_created: false,
      errors: [],
      warnings: [],
      no_snapshot_reason: 'no_changes',
      elapsed_ms: 0,
      channels: [],
      requests: {
        messages: { requests: 0, throttled: 0, achieved_rps: 0 },
        default: { requests: 0, throttled: 0, achieved_rps: 0 },
      },
    },
  };
}

describe('teams backup scope and per-team isolation', () => {
  let container: Container;
  let backup_team: Mock;
  let list_teams: Mock;

  beforeEach(() => {
    process.exitCode = undefined;
    backup_team = vi.fn();
    list_teams = vi.fn(async () => [{ id: 'team-a' }, { id: 'team-b' }]);
    container = new Container();
    container
      .bind(TEAMS_BACKUP_USE_CASE_TOKEN)
      .toConstantValue({ backup_team } as unknown as TeamsBackupUseCase);
    container
      .bind(TEAMS_CATALOG_USE_CASE_TOKEN)
      .toConstantValue({ list_teams } as unknown as TeamsCatalogUseCase);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('rejects --channel with --all before listing teams or backing anything up', async () => {
    await expect(
      execute_teams_backup(container, { tenant: TENANT, all: true, channel: 'channel-1' }),
    ).rejects.toThrow('--channel requires exactly one --team');

    expect(list_teams).not.toHaveBeenCalled();
    expect(backup_team).not.toHaveBeenCalled();
  });

  it('rejects --channel with several --team values before any Graph call', async () => {
    await expect(
      execute_teams_backup(container, {
        tenant: TENANT,
        team: ['team-a', 'team-b'],
        channel: 'channel-1',
      }),
    ).rejects.toThrow('--channel requires exactly one --team');

    expect(backup_team).not.toHaveBeenCalled();
  });

  it('keeps backing up later teams when one team fails, and exits partial', async () => {
    backup_team
      .mockRejectedValueOnce(new Error('channel listing refused'))
      .mockResolvedValueOnce(healthy_result('team-b'));

    await execute_teams_backup(container, { tenant: TENANT, team: ['team-a', 'team-b'] });

    expect(backup_team).toHaveBeenCalledTimes(2);
    expect(backup_team.mock.calls[1]?.[1]).toBe('team-b');
    expect(process.exitCode).toBe(2);
  });

  it('stops on an auth failure and rethrows it so the category exit applies', async () => {
    backup_team.mockRejectedValueOnce(new AuthError('consent revoked'));

    await expect(
      execute_teams_backup(container, { tenant: TENANT, team: ['team-a', 'team-b'] }),
    ).rejects.toThrow(AuthError);

    expect(backup_team).toHaveBeenCalledTimes(1);
  });

  it('rethrows a single-team failure so the fatal category exit is kept', async () => {
    backup_team.mockRejectedValueOnce(new Error('team not found'));

    await expect(
      execute_teams_backup(container, { tenant: TENANT, team: ['team-a'] }),
    ).rejects.toThrow('team not found');
  });
});
