import { describe, expect, it } from 'vitest';
import type {
  TeamsChannelCursor,
  TeamsChannelShard,
  TeamsSnapshotIndex,
} from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3TeamsChannelCursorRepository } from '@/adapters/s3-teams-channel-cursor-repository.adapter';
import { S3TeamsChannelShardRepository } from '@/adapters/s3-teams-channel-shard-repository.adapter';
import { S3TeamsIndexRepository } from '@/adapters/s3-teams-index-repository.adapter';

const TEAM = '00000000-0000-0000-0000-000000000001';
const SNAPSHOT = 'teams-snap-2000-bbbbbb';
const CHANNEL = 'channel-1';
const TIMESTAMP = '2025-01-01T00:00:00.000Z';

function shard(): TeamsChannelShard {
  return {
    format_version: 1,
    team_id: TEAM,
    channel_id: CHANNEL,
    channel: { id: CHANNEL },
    members: [],
    tabs: [],
    read_mode: 'full',
    threads: {},
  } as unknown as TeamsChannelShard;
}

function index(shard_key: string, shard_checksum: string): TeamsSnapshotIndex {
  return {
    id: `${TEAM}-${SNAPSHOT}`,
    format_version: 1,
    tenant_id: 'tenant-test',
    team_id: TEAM,
    snapshot_id: SNAPSHOT,
    created_at: new Date(TIMESTAMP),
    team: { id: TEAM },
    members: [],
    channels: [
      {
        channel_id: CHANNEL,
        shard_key,
        shard_checksum,
        thread_count: 0,
        message_count: 0,
        size_bytes: 0,
      },
    ],
    totals: { thread_count: 0, message_count: 0, size_bytes: 0 },
  } as unknown as TeamsSnapshotIndex;
}

function cursor(baseline_shard_key: string): TeamsChannelCursor {
  return {
    format_version: 1,
    team_id: TEAM,
    channel_id: CHANNEL,
    baseline_shard_key,
    updated_at: TIMESTAMP,
  } as TeamsChannelCursor;
}

describe('teams storage through the real S3 adapters over in-memory storage', () => {
  it('writes shards, manifests and cursors to their own prefixes and reads them back (P10)', async () => {
    const { ctx, keys } = in_memory_tenant_context();
    const stored = await new S3TeamsChannelShardRepository().save(ctx, shard());
    await new S3TeamsIndexRepository().save(ctx, index(stored.storage_key, stored.checksum));
    await new S3TeamsChannelCursorRepository().save(ctx, cursor(stored.storage_key));

    expect(
      keys()
        .map((key) => key.split('/').slice(0, 2).join('/'))
        .sort(),
    ).toEqual(['teams/_meta', 'teams/manifests', 'teams/shards']);
    expect(stored.storage_key.startsWith(`teams/shards/${TEAM}/${CHANNEL}/`)).toBe(true);
    await expect(
      new S3TeamsChannelShardRepository().load(ctx, stored.storage_key),
    ).resolves.toMatchObject({
      team_id: TEAM,
    });
    await expect(new S3TeamsIndexRepository().list_by_team(ctx, TEAM)).resolves.toMatchObject({
      indexes: [{ snapshot_id: SNAPSHOT }],
    });
    await expect(
      new S3TeamsChannelCursorRepository().load(ctx, TEAM, CHANNEL),
    ).resolves.toMatchObject({
      baseline_shard_key: stored.storage_key,
    });
  });

  it('scan reports a cursor copied under another channel key as unreadable through real storage (P9)', async () => {
    const harness = in_memory_tenant_context();
    const cursors = new S3TeamsChannelCursorRepository();
    await cursors.save(harness.ctx, cursor('teams/shards/x/y/z.json'));
    const original = harness.keys().find((key) => key.startsWith('teams/_meta/'));
    const moved = `teams/_meta/${TEAM}/channels/channel-2.json`;
    harness.set_raw(moved, harness.raw(original ?? '') ?? Buffer.alloc(0));

    const scan = await cursors.scan(harness.ctx, TEAM);

    expect(scan.unreadable_keys).toEqual([moved]);
    expect(scan.cursors.map((c) => c.channel_id)).toEqual([CHANNEL]);
  });
});
