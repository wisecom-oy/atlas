import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from 'inversify';
import { rethrow_if_teams_access_denied } from '@wisecom/atlas-m365-graph';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import { execute_teams_backup } from '@/commands/teams/command.handlers';
import { handle_fatal_error } from '@/fatal-error';
import {
  AuthError,
  GraphUnavailableError,
  OwnerBusyError,
  ThrottledError,
  TEAMS_BACKUP_USE_CASE_TOKEN,
  TEAMS_CATALOG_USE_CASE_TOKEN,
  type TeamsBackupUseCase,
  type TeamsBackupResult,
  type TeamsCatalogUseCase,
} from '@wisecom/atlas-types';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const TENANT = '00000000-0000-0000-0000-000000000001';

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

/** What a Teams Graph call rejects with when Graph answers 403 with `code`. */
function teams_403(code: string): unknown {
  try {
    rethrow_if_teams_access_denied(graph_error(403, code));
  } catch (refusal) {
    return refusal;
  }
  throw new Error('a 403 always rethrows');
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

  it('refuses a domain tenant with --all before listing teams or backing anything up (#723)', async () => {
    await expect(
      execute_teams_backup(container, { tenant: 'contoso.onmicrosoft.com', all: true }),
    ).rejects.toThrow('tenant GUID');

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

  it('reports a team another operation holds as that team failure and backs up the rest (#623)', async () => {
    backup_team
      .mockRejectedValueOnce(
        new OwnerBusyError({ workload: 'teams', owner_id: 'team-a', held_by_operation: 'backup' }),
      )
      .mockResolvedValueOnce(healthy_result('team-b'));

    await execute_teams_backup(container, { tenant: TENANT, team: ['team-a', 'team-b'] });

    expect(backup_team).toHaveBeenCalledTimes(2);
    expect(backup_team.mock.calls[1]?.[1]).toBe('team-b');
    expect(process.exitCode).toBe(2);
  });

  it('rethrows a busy single team so the command exits with the busy category (#623)', async () => {
    backup_team.mockRejectedValueOnce(
      new OwnerBusyError({ workload: 'teams', owner_id: 'team-a' }),
    );

    await expect(
      execute_teams_backup(container, { tenant: TENANT, team: ['team-a'] }),
    ).rejects.toBeInstanceOf(OwnerBusyError);
  });

  it('stops on an auth failure and rethrows it so the category exit applies', async () => {
    backup_team.mockRejectedValueOnce(new AuthError('consent revoked'));

    await expect(
      execute_teams_backup(container, { tenant: TENANT, team: ['team-a', 'team-b'] }),
    ).rejects.toThrow(AuthError);

    expect(backup_team).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'GraphUnavailableError',
      () => new GraphUnavailableError('Graph unavailable', { retries: 12, elapsed_ms: 1_411_000 }),
    ],
    ['ThrottledError', () => new ThrottledError('Graph kept throttling', 30_000)],
  ])(
    'stops --all at the first team that ends in %s and rethrows it (#881)',
    async (_, make_outage) => {
      list_teams.mockResolvedValueOnce([{ id: 'team-a' }, { id: 'team-b' }, { id: 'team-c' }]);
      const outage = make_outage();
      backup_team.mockResolvedValueOnce(healthy_result('team-a')).mockRejectedValueOnce(outage);

      await expect(execute_teams_backup(container, { tenant: TENANT, all: true })).rejects.toBe(
        outage,
      );

      // team-c would spend its own retry budget on the same outage.
      expect(backup_team).toHaveBeenCalledTimes(2);
      expect(backup_team.mock.calls.map((call) => call[1])).toEqual(['team-a', 'team-b']);
    },
  );

  // Issue #865: a 403 that is not a missing grant fails one team, not the run.
  it('backs up the other teams with --all after a non-permission 403, and exits partial', async () => {
    backup_team
      .mockRejectedValueOnce(teams_403('UnknownError'))
      .mockResolvedValueOnce(healthy_result('team-b'));

    await execute_teams_backup(container, { tenant: TENANT, all: true });

    expect(backup_team.mock.calls.map((call) => call[1])).toEqual(['team-a', 'team-b']);
    expect(process.exitCode).toBe(2);
  });

  it('stops --all on a missing-grant 403, which exits 4', async () => {
    const refusal = teams_403('Authorization_RequestDenied');
    backup_team.mockRejectedValueOnce(refusal);

    await expect(execute_teams_backup(container, { tenant: TENANT, all: true })).rejects.toBe(
      refusal,
    );
    handle_fatal_error(refusal);

    expect(backup_team).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(4);
  });

  it('rethrows a single-team failure so the fatal category exit is kept', async () => {
    backup_team.mockRejectedValueOnce(new Error('team not found'));

    await expect(
      execute_teams_backup(container, { tenant: TENANT, team: ['team-a'] }),
    ).rejects.toThrow('team not found');
  });
});
