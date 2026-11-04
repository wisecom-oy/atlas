import { describe, expect, it, vi } from 'vitest';
import type {
  TeamsChannelShard,
  TeamsChannelShardRepository,
  TeamsConnector,
  TeamsIndexRepository,
  TeamsSnapshotIndex,
  TeamsSnapshotListing,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';
import { TeamsCatalogService } from '@/services/catalog/catalog.service';

const TENANT = 'tenant';
const TEAM = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab';
const SNAPSHOT = 'teams-snap-2000-bbbbbb';

function index_with_channels(): TeamsSnapshotIndex {
  const entry = (channel_id: string, shard_key: string) => ({
    channel_id,
    shard_key,
    shard_checksum: 'unused',
    thread_count: 1,
    message_count: 1,
    size_bytes: 0,
  });
  return {
    id: `${TEAM}-${SNAPSHOT}`,
    format_version: 1,
    tenant_id: TENANT,
    team_id: TEAM,
    snapshot_id: SNAPSHOT,
    created_at: new Date('2025-01-01T00:00:00.000Z'),
    team: { id: TEAM },
    members: [],
    channels: [entry('channel-1', 'shard-1'), entry('channel-2', 'shard-2')],
    totals: { thread_count: 2, message_count: 2, size_bytes: 0 },
  };
}

function shard(channel_id: string, root_id: string): TeamsChannelShard {
  return {
    format_version: 1,
    team_id: TEAM,
    channel_id,
    channel: { id: channel_id },
    members: [],
    tabs: [],
    read_mode: 'full',
    threads: {
      [root_id]: {
        root: {
          storage_key: `key-${root_id}`,
          checksum: 'unused',
          size_bytes: 1,
          last_modified_at: '2025-01-01T00:00:00.000Z',
          hosted: {},
        },
        replies: {},
      },
    },
  };
}

function setup(
  find_result: TeamsSnapshotIndex | undefined = index_with_channels(),
  listing: TeamsSnapshotListing = { indexes: [], unreadable_keys: [], unsupported_keys: [] },
) {
  const ctx = { destroy: vi.fn() };
  const list_by_team = vi.fn(async () => listing);
  const find_by_snapshot = vi.fn(async (): Promise<TeamsSnapshotIndex | undefined> => find_result);
  const shards: Record<string, TeamsChannelShard> = {
    'shard-1': shard('channel-1', 'root-a'),
    'shard-2': shard('channel-2', 'root-b'),
  };
  const load = vi.fn(async (_ctx: unknown, key: string) => shards[key]);
  const service = new TeamsCatalogService(
    { create_readonly: vi.fn(async () => ctx) } as unknown as TenantContextFactory,
    {} as TeamsConnector,
    { list_by_team, find_by_snapshot } as unknown as TeamsIndexRepository,
    { load } as unknown as TeamsChannelShardRepository,
  );
  return { service, list_by_team, find_by_snapshot, load };
}

describe('TeamsCatalogService', () => {
  it('lists snapshots under the lowercased team id (A9)', async () => {
    const { service, list_by_team } = setup();

    await service.list_teams_snapshots(TENANT, TEAM.toUpperCase());

    expect(list_by_team).toHaveBeenCalledWith(expect.anything(), TEAM);
  });

  it('returns the unreadable and unsupported index keys beside the readable snapshots (M8)', async () => {
    const listing = {
      indexes: [],
      unreadable_keys: [`teams/manifests/${TEAM}/teams-snap-1000-aaaaaa.json`],
      unsupported_keys: [`teams/manifests/${TEAM}/teams-snap-2000-cccccc.json`],
    };
    const { service } = setup(undefined, listing);

    await expect(service.list_teams_snapshots(TENANT, TEAM)).resolves.toEqual(listing);
  });

  it('flattens the threads of every channel shard, tagged with their channel and root', async () => {
    const { service, load } = setup();

    const threads = await service.list_snapshot_threads(TENANT, TEAM, SNAPSHOT);

    expect(threads.map((t) => [t.channel_id, t.root_id]).sort()).toEqual([
      ['channel-1', 'root-a'],
      ['channel-2', 'root-b'],
    ]);
    expect(load).toHaveBeenCalledWith(expect.anything(), 'shard-1');
    expect(load).toHaveBeenCalledWith(expect.anything(), 'shard-2');
  });

  it('raises NotFoundError when the snapshot index does not exist', async () => {
    const { service, find_by_snapshot } = setup();
    find_by_snapshot.mockResolvedValueOnce(undefined);

    await expect(service.list_snapshot_threads(TENANT, TEAM, SNAPSHOT)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
