import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import { execute_teams_list_snapshots } from '@/commands/teams/command.handlers';
import { EXIT_CONTENT_UNREADABLE, EXIT_FORMAT_UNSUPPORTED } from '@/command-unreadable-objects';
import {
  TEAMS_BACKUP_USE_CASE_TOKEN,
  TEAMS_CATALOG_USE_CASE_TOKEN,
  type TeamsBackupUseCase,
  type TeamsCatalogUseCase,
  type TeamsSnapshotListing,
} from '@wisecom/atlas-types';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const TENANT = 'tenant-example';
const UNREADABLE_KEY = 'teams/manifests/team-a/teams-snap-1000-aaaaaa.json';
const UNSUPPORTED_KEY = 'teams/manifests/team-a/teams-snap-2000-bbbbbb.json';

describe('teams list-snapshots listing', () => {
  let container: Container;
  let list_teams_snapshots: Mock;

  beforeEach(() => {
    list_teams_snapshots = vi.fn();
    container = new Container();
    container
      .bind(TEAMS_BACKUP_USE_CASE_TOKEN)
      .toConstantValue({ backup_team: vi.fn() } as unknown as TeamsBackupUseCase);
    container
      .bind(TEAMS_CATALOG_USE_CASE_TOKEN)
      .toConstantValue({ list_teams_snapshots } as unknown as TeamsCatalogUseCase);
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('reports no snapshots when the listing has no indexes', async () => {
    const listing: TeamsSnapshotListing = {
      indexes: [],
      unreadable_keys: [],
      unsupported_keys: [],
    };
    list_teams_snapshots.mockResolvedValueOnce(listing);

    await execute_teams_list_snapshots(container, { tenant: TENANT, team: 'team-a' });

    expect(logger.info).toHaveBeenCalledWith('No snapshots found.');
  });

  it('names unreadable indexes with the quarantine command and exits 9 (issue #694)', async () => {
    const listing: TeamsSnapshotListing = {
      indexes: [],
      unreadable_keys: [UNREADABLE_KEY],
      unsupported_keys: [],
    };
    list_teams_snapshots.mockResolvedValueOnce(listing);

    await execute_teams_list_snapshots(container, { tenant: TENANT, team: 'team-a' });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`atlas teams quarantine --key ${UNREADABLE_KEY}`),
    );
    expect(process.exitCode).toBe(EXIT_CONTENT_UNREADABLE);
  });

  it('names indexes written in a newer format, says to upgrade, and exits 9', async () => {
    const listing: TeamsSnapshotListing = {
      indexes: [],
      unreadable_keys: [],
      unsupported_keys: [UNSUPPORTED_KEY],
    };
    list_teams_snapshots.mockResolvedValueOnce(listing);

    await execute_teams_list_snapshots(container, { tenant: TENANT, team: 'team-a' });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(UNSUPPORTED_KEY));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Upgrade Atlas'));
    // A newer-format index is intact: the fix is an upgrade, so no quarantine hint, but never exit 0.
    expect(logger.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_FORMAT_UNSUPPORTED);
  });
});
