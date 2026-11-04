import { describe, expect, it, vi } from 'vitest';
import type {
  TeamsChannelCursorRepository,
  TeamsChannelIndexEntry,
  TeamsChannelShardRepository,
  TeamsGraphResource,
  TeamsIndexRepository,
  TeamsSnapshotIndex,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  persist_team_snapshot,
  save_channel_shards,
  type ChannelSave,
  type SnapshotPersistInput,
  type SnapshotPorts,
} from '@/services/backup/team-snapshot-persister';
import { BACKUP_AT, TEAM_ID } from './channel-backup-processor-harness';
import { channel_output } from './backup-service-harness';

const CTX = {} as TenantContext;
const TEAM: TeamsGraphResource = { id: TEAM_ID, displayName: 'Team' };

function entry(channel_id: string, shard_key = `shard-${channel_id}`): TeamsChannelIndexEntry {
  return {
    channel_id,
    shard_key,
    shard_checksum: `sum-${shard_key}`,
    thread_count: 0,
    message_count: 0,
    size_bytes: 0,
  };
}

function persist_input(overrides: Partial<SnapshotPersistInput> = {}): SnapshotPersistInput {
  return {
    tenant_id: 'tenant-1',
    team_id: TEAM_ID,
    team_display_name: 'Team',
    backup_at: new Date(BACKUP_AT),
    team: TEAM,
    members: [],
    channels: [entry('channel-1')],
    previous: undefined,
    saves: [],
    ...overrides,
  };
}

function ports(): SnapshotPorts {
  return {
    indexes: { save: vi.fn(async () => undefined) } as unknown as TeamsIndexRepository,
    cursors: { save: vi.fn(async () => undefined) } as unknown as TeamsChannelCursorRepository,
  };
}

function previous_index(created_at: Date, channels: TeamsChannelIndexEntry[]): TeamsSnapshotIndex {
  return {
    team: TEAM,
    members: [],
    channels,
    created_at,
  } as unknown as TeamsSnapshotIndex;
}

describe('save_channel_shards', () => {
  it('saves a changed shard and builds its index entry from the stored blob', async () => {
    const output = channel_output('channel-1');
    const shards = {
      save: vi.fn(async () => ({ storage_key: 'shard-new', checksum: 'sum-new', size_bytes: 10 })),
    } as unknown as TeamsChannelShardRepository;

    const saves = await save_channel_shards(CTX, shards, new Map([['channel-1', output]]));

    expect(shards.save).toHaveBeenCalledWith(CTX, output.shard);
    expect(saves[0]?.entry).toMatchObject({
      channel_id: 'channel-1',
      shard_key: 'shard-new',
      shard_checksum: 'sum-new',
    });
  });

  it('keeps a reused entry and saves no shard for it', async () => {
    const reused = entry('channel-1', 'shard-old');
    const shards = { save: vi.fn() } as unknown as TeamsChannelShardRepository;

    const saves = await save_channel_shards(
      CTX,
      shards,
      new Map([['channel-1', channel_output('channel-1', { reused_entry: reused })]]),
    );

    expect(shards.save).not.toHaveBeenCalled();
    expect(saves[0]?.entry).toBe(reused);
  });
});

describe('persist_team_snapshot skip reasons', () => {
  it('writes no index and reports no_content when the team has no channels', async () => {
    const p = ports();

    const result = await persist_team_snapshot(CTX, p, persist_input({ channels: [] }));

    expect(result).toEqual({ index: undefined, no_snapshot_reason: 'no_content' });
    expect(p.indexes.save).not.toHaveBeenCalled();
  });

  it('writes no index and reports no_changes when content matches the latest index', async () => {
    const p = ports();
    const previous = previous_index(new Date(0), [entry('channel-1')]);

    const result = await persist_team_snapshot(CTX, p, persist_input({ previous }));

    expect(result).toEqual({ index: undefined, no_snapshot_reason: 'no_changes' });
    expect(p.indexes.save).not.toHaveBeenCalled();
  });

  it('still saves the processed channel cursors when no index is written', async () => {
    const p = ports();
    const previous = previous_index(new Date(0), [entry('channel-1')]);
    const save: ChannelSave = {
      channel_id: 'channel-1',
      entry: entry('channel-1'),
      output: channel_output('channel-1'),
    };

    await persist_team_snapshot(CTX, p, persist_input({ previous, saves: [save] }));

    expect(p.cursors.save).toHaveBeenCalledTimes(1);
  });
});

describe('persist_team_snapshot index', () => {
  it('saves a new index for changed content and returns it', async () => {
    const p = ports();

    const result = await persist_team_snapshot(CTX, p, persist_input());

    expect(result.no_snapshot_reason).toBeUndefined();
    expect(p.indexes.save).toHaveBeenCalledWith(CTX, result.index);
    expect(result.index).toMatchObject({
      format_version: 1,
      team_id: TEAM_ID,
      channels: [entry('channel-1')],
    });
    expect(result.index?.snapshot_id).toMatch(/^teams-snap-\d+-[0-9a-f]{6}$/);
  });

  it('gives the new index a created_at strictly after the previous one (R11)', async () => {
    const future = new Date(Date.now() + 60_000);
    const previous = previous_index(future, [entry('channel-1', 'shard-old')]);

    const result = await persist_team_snapshot(
      CTX,
      ports(),
      persist_input({ previous, channels: [entry('channel-1', 'shard-new')] }),
    );

    expect(result.index?.created_at.getTime()).toBeGreaterThan(future.getTime());
  });

  it('binds each processed channel cursor to its merged shard key', async () => {
    const p = ports();
    const failed = {
      m1: {
        item_id: 'm1',
        drive_id: 'channel-1',
        name: 'm1',
        reason: 'r',
        attempts: 1,
        first_failed_at: BACKUP_AT,
        last_failed_at: BACKUP_AT,
      },
    };
    const save: ChannelSave = {
      channel_id: 'channel-1',
      entry: entry('channel-1', 'shard-new'),
      output: channel_output('channel-1', { next_link: 'link-2', failed_roots: failed }),
    };

    await persist_team_snapshot(
      CTX,
      p,
      persist_input({ channels: [entry('channel-1', 'shard-new')], saves: [save] }),
    );

    expect(p.cursors.save).toHaveBeenCalledWith(CTX, {
      format_version: 1,
      team_id: TEAM_ID,
      channel_id: 'channel-1',
      delta_link: 'link-2',
      baseline_shard_key: 'shard-new',
      failed_roots: failed,
      updated_at: BACKUP_AT,
    });
  });

  it('saves no cursors when the index save fails, so the old baseline stays', async () => {
    const p = ports();
    vi.mocked(p.indexes.save).mockRejectedValueOnce(new Error('storage unavailable'));
    const save: ChannelSave = {
      channel_id: 'channel-1',
      entry: entry('channel-1'),
      output: channel_output('channel-1'),
    };

    await expect(persist_team_snapshot(CTX, p, persist_input({ saves: [save] }))).rejects.toThrow(
      'storage unavailable',
    );
    expect(p.cursors.save).not.toHaveBeenCalled();
  });
});
