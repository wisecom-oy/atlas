import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import { execute_teams_backup } from '@/commands/teams-command.handlers';
import { EXIT_PARTIAL } from '@/command-run-outcome';
import { render_static_view } from '@/ui/render';
import {
  TEAMS_BACKUP_USE_CASE_TOKEN,
  TEAMS_CATALOG_USE_CASE_TOKEN,
  type TeamsBackupResult,
  type TeamsBackupUseCase,
  type TeamsCatalogUseCase,
} from '@wisecom/atlas-types';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const TENANT = 'tenant-example';
const NO_CONTENT = 'No Teams messages found';
const NO_CHANGES = 'No Teams changes detected';

/** A run that created no snapshot; `healthy` decides whether the run finished cleanly. */
function no_snapshot_result(healthy: boolean): TeamsBackupResult {
  return {
    team_id: 'team-a',
    snapshot: undefined,
    interrupted: false,
    summary: {
      healthy,
      channels_scanned: 1,
      channels_full_read: 0,
      threads_changed: 0,
      messages_stored: 0,
      messages_deduplicated: 0,
      threads_deleted: 0,
      hosted_content_stored: 0,
      cursor_updated: false,
      snapshot_created: false,
      errors: healthy ? [] : ['channel listing refused'],
      warnings: [],
      no_snapshot_reason: 'no_content',
    },
  };
}

describe('teams backup no-snapshot report', () => {
  let container: Container;
  let backup_team: Mock;

  beforeEach(() => {
    process.exitCode = undefined;
    backup_team = vi.fn();
    container = new Container();
    container
      .bind(TEAMS_BACKUP_USE_CASE_TOKEN)
      .toConstantValue({ backup_team } as unknown as TeamsBackupUseCase);
    container
      .bind(TEAMS_CATALOG_USE_CASE_TOKEN)
      .toConstantValue({ list_teams: vi.fn() } as unknown as TeamsCatalogUseCase);
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('reports no messages on a healthy run with no content', async () => {
    backup_team.mockResolvedValueOnce(no_snapshot_result(true));

    await execute_teams_backup(container, { tenant: TENANT, team: ['team-a'] });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(NO_CONTENT));
  });

  it('does not claim no messages exist when the run was unhealthy', async () => {
    backup_team.mockResolvedValueOnce(no_snapshot_result(false));

    await execute_teams_backup(container, { tenant: TENANT, team: ['team-a'] });

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining(NO_CONTENT));
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining(NO_CHANGES));
  });

  it('exits partial when the run is unhealthy with no error entries', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const result = no_snapshot_result(false);
    backup_team.mockResolvedValueOnce({ ...result, summary: { ...result.summary, errors: [] } });

    await execute_teams_backup(container, { tenant: TENANT, team: ['team-a'] });

    expect(logger.error).toHaveBeenCalledWith('Status: UNHEALTHY');
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('reports each team as soon as it finishes, before the next team starts', async () => {
    vi.mocked(render_static_view).mockClear();
    let rendered_before_second = 0;
    backup_team.mockResolvedValueOnce(no_snapshot_result(true)).mockImplementationOnce(async () => {
      rendered_before_second = vi.mocked(render_static_view).mock.calls.length;
      return no_snapshot_result(true);
    });

    await execute_teams_backup(container, { tenant: TENANT, team: ['team-a', 'team-b'] });

    expect(rendered_before_second).toBeGreaterThan(0);
  });

  it('stops on Ctrl+C without reporting the cancelled team as failed', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    backup_team.mockImplementationOnce(async (_tenant: string, _team: string, options) => {
      process.emit('SIGINT');
      throw (options.abort_signal as AbortSignal).reason;
    });

    await execute_teams_backup(container, { tenant: TENANT, team: ['team-a', 'team-b'] });

    expect(backup_team).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Run interrupted before all items were processed');
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('Run incomplete'));
    expect(logger.error).toHaveBeenCalledWith('Status: UNHEALTHY');
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });
});
