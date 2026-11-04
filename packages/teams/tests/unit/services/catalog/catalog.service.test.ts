import { describe, expect, it, vi } from 'vitest';
import type {
  TeamsConnector,
  TeamsManifestRepository,
  TeamsSnapshotListing,
  TeamsSnapshotManifest,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { ConfigError, NotFoundError } from '@wisecom/atlas-types';
import { TeamsCatalogService } from '@/services/catalog/catalog.service';

const TENANT = 'tenant-1';
const TEAM = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab';
const SNAPSHOT = 'teams-snap-2000-bbbbbb';

function manifest_with_threads(): TeamsSnapshotManifest {
  return {
    team_id: TEAM,
    snapshot_id: SNAPSHOT,
    channels: [
      {
        id: 'channel-1',
        threads: { 'root-a': { storage_key: 'k-a', backup_at: 'now' } },
      },
      {
        id: 'channel-2',
        threads: { 'root-b': { storage_key: 'k-b', backup_at: 'now' } },
      },
    ],
  } as unknown as TeamsSnapshotManifest;
}

function setup(find_result: TeamsSnapshotManifest | undefined = manifest_with_threads()) {
  const ctx = { destroy: vi.fn() };
  const create_readonly = vi.fn(async () => ctx);
  const list_snapshots_by_team = vi.fn(async (): Promise<TeamsSnapshotListing> => ({
    manifests: [],
    unreadable_keys: [],
  }));
  const find_by_snapshot = vi.fn(
    async (): Promise<TeamsSnapshotManifest | undefined> => find_result,
  );
  const service = new TeamsCatalogService(
    { create_readonly } as unknown as TenantContextFactory,
    {} as TeamsConnector,
    { list_snapshots_by_team, find_by_snapshot } as unknown as TeamsManifestRepository,
  );
  return { service, list_snapshots_by_team, find_by_snapshot };
}

describe('TeamsCatalogService', () => {
  it('lists snapshots under the lowercased team id (A9)', async () => {
    const { service, list_snapshots_by_team } = setup();

    await service.list_teams_snapshots(TENANT, TEAM.toUpperCase());

    expect(list_snapshots_by_team).toHaveBeenCalledWith(expect.anything(), TEAM);
  });

  it('returns the unreadable manifest keys beside the readable snapshots (M8)', async () => {
    const { service, list_snapshots_by_team } = setup();
    list_snapshots_by_team.mockResolvedValueOnce({
      manifests: [],
      unreadable_keys: ['teams/manifests/team/teams-snap-1000-aaaaaa.json'],
    });

    const listing = await service.list_teams_snapshots(TENANT, TEAM);

    expect(listing.unreadable_keys).toEqual(['teams/manifests/team/teams-snap-1000-aaaaaa.json']);
  });

  it('looks up a snapshot under the lowercased team id and flattens its threads (A9)', async () => {
    const { service, find_by_snapshot } = setup();

    const threads = await service.list_snapshot_threads(TENANT, TEAM.toUpperCase(), SNAPSHOT);

    expect(find_by_snapshot).toHaveBeenCalledWith(expect.anything(), TEAM, SNAPSHOT);
    expect(threads).toEqual([
      { storage_key: 'k-a', backup_at: 'now', channel_id: 'channel-1', root_id: 'root-a' },
      { storage_key: 'k-b', backup_at: 'now', channel_id: 'channel-2', root_id: 'root-b' },
    ]);
  });

  it('throws NotFoundError when the snapshot does not exist', async () => {
    const { service, find_by_snapshot } = setup();
    find_by_snapshot.mockResolvedValueOnce(undefined);

    await expect(service.list_snapshot_threads(TENANT, TEAM, SNAPSHOT)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('rejects a team id that is not a GUID (A9)', async () => {
    const { service } = setup();

    await expect(service.list_teams_snapshots(TENANT, 'not-a-guid')).rejects.toThrow(ConfigError);
  });
});
