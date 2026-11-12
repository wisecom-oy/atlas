import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import { execute_teams_backup } from '@/commands/teams/command.handlers';
import { EXIT_PARTIAL } from '@/command-run-outcome';
import { EXIT_CONTENT_UNREADABLE } from '@/command-unreadable-objects';
import {
  attach_unreadable_keys,
  TEAMS_BACKUP_USE_CASE_TOKEN,
  TEAMS_CATALOG_USE_CASE_TOKEN,
  type TeamsBackupResult,
  type TeamsBackupUseCase,
  type TeamsCatalogUseCase,
} from '@wisecom/atlas-types';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const TENANT = 'tenant-example';
const DAMAGED_KEY = 'teams/manifests/team-a/teams-snap-2000-bbbbbb.json';
const HINT = `atlas teams quarantine --key ${DAMAGED_KEY}`;

/** A finished run; `errors` are channel failures, `unreadable_keys` the damaged newer indexes. */
function result(errors: string[], unreadable_keys?: string[]): TeamsBackupResult {
  return {
    team_id: 'team-a',
    snapshot: undefined,
    interrupted: false,
    summary: {
      healthy: errors.length === 0,
      channels_scanned: 1,
      channels_full_read: 0,
      threads_changed: 0,
      messages_stored: 0,
      messages_deduplicated: 0,
      threads_deleted: 0,
      hosted_content_stored: 0,
      cursor_updated: true,
      snapshot_created: false,
      errors,
      warnings: [],
      no_snapshot_reason: errors.length === 0 ? 'no_changes' : undefined,
      unreadable_keys,
      elapsed_ms: 0,
      channels: [],
      requests: {
        messages: { requests: 0, throttled: 0, achieved_rps: 0 },
        default: { requests: 0, throttled: 0, achieved_rps: 0 },
      },
    },
  };
}

/**
 * Issue #694: a Teams backup that skipped a damaged snapshot index finishes, names the key with
 * the quarantine command, and exits 9, unless a channel or team also failed, which keeps exit 2.
 */
describe('teams backup with a damaged snapshot index', () => {
  let container: Container;
  let backup_team: Mock;
  let errors: string[];

  beforeEach(() => {
    process.exitCode = undefined;
    errors = [];
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
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation((message: string) => {
      errors.push(message);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('exits 9 and prints the quarantine command when the damage is the only finding', async () => {
    backup_team.mockResolvedValueOnce(result([], [DAMAGED_KEY]));

    await execute_teams_backup(container, { tenant: TENANT, team: ['team-a'] });

    expect(errors).toContain(`  ${HINT}`);
    expect(errors).toContain('Status: UNHEALTHY');
    expect(logger.success).not.toHaveBeenCalledWith('Status: HEALTHY');
    expect(process.exitCode).toBe(EXIT_CONTENT_UNREADABLE);
  });

  it('keeps exit 2 and still names the key when a channel also failed', async () => {
    backup_team.mockResolvedValueOnce(result(['Channel channel-1: boom'], [DAMAGED_KEY]));

    await execute_teams_backup(container, { tenant: TENANT, team: ['team-a'] });

    expect(errors).toContain(`  ${HINT}`);
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('keeps exit 2 when a later team failed a channel after an earlier one found damage', async () => {
    backup_team
      .mockResolvedValueOnce(result([], [DAMAGED_KEY]))
      .mockResolvedValueOnce({ ...result(['Channel channel-1: boom']), team_id: 'team-b' });

    await execute_teams_backup(container, { tenant: TENANT, team: ['team-a', 'team-b'] });

    expect(errors).toContain(`  ${HINT}`);
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('names the damaged key of a team that threw and keeps exit 2 for the failed team', async () => {
    backup_team
      .mockRejectedValueOnce(
        attach_unreadable_keys(new Error('shard write refused'), [DAMAGED_KEY]),
      )
      .mockResolvedValueOnce({ ...result([]), team_id: 'team-b' });

    await execute_teams_backup(container, { tenant: TENANT, team: ['team-a', 'team-b'] });

    expect(errors).toContain(`  ${HINT}`);
    expect(errors).toContain('  team error: team-a: shard write refused');
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('names the damaged key before rethrowing the failure of a single team', async () => {
    const failure = attach_unreadable_keys(new Error('shard write refused'), [DAMAGED_KEY]);
    backup_team.mockRejectedValueOnce(failure);

    await expect(
      execute_teams_backup(container, { tenant: TENANT, team: ['team-a'] }),
    ).rejects.toBe(failure);

    expect(errors).toContain(`  ${HINT}`);
  });

  it('stays healthy with exit 0 when every index reads', async () => {
    backup_team.mockResolvedValueOnce(result([]));

    await execute_teams_backup(container, { tenant: TENANT, team: ['team-a'] });

    expect(logger.success).toHaveBeenCalledWith('Status: HEALTHY');
    expect(process.exitCode).toBeUndefined();
  });
});
