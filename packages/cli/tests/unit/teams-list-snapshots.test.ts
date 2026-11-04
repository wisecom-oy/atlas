import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import { execute_teams_list_snapshots } from '@/commands/teams-command.handlers';
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports no snapshots when the listing has no manifests', async () => {
    const listing: TeamsSnapshotListing = { manifests: [], unreadable_keys: [] };
    list_teams_snapshots.mockResolvedValueOnce(listing);

    await execute_teams_list_snapshots(container, { tenant: TENANT, team: 'team-a' });

    expect(logger.info).toHaveBeenCalledWith('No snapshots found.');
  });

  it('warns and names the keys of manifests that could not be read', async () => {
    const listing: TeamsSnapshotListing = { manifests: [], unreadable_keys: [UNREADABLE_KEY] };
    list_teams_snapshots.mockResolvedValueOnce(listing);

    await execute_teams_list_snapshots(container, { tenant: TENANT, team: 'team-a' });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(UNREADABLE_KEY));
  });
});
