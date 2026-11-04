import { describe, expect, it } from 'vitest';
import type {
  TeamsChannelShard,
  TeamsHostedRef,
  TeamsMessageRef,
  TeamsThread,
} from '@wisecom/atlas-types';
import {
  build_channel_cursor,
  build_channel_index_entry,
  build_team_index,
} from '@/services/backup/backup-index-builder';

const TEAM_ID = 'team-1';
const CHANNEL_ID = 'channel-1';
const BACKUP_AT = '2025-01-01T00:00:00.000Z';

function message_ref(
  storage_key: string,
  size_bytes: number,
  hosted: Record<string, TeamsHostedRef> = {},
): TeamsMessageRef {
  return {
    storage_key,
    checksum: `sum-${storage_key}`,
    size_bytes,
    last_modified_at: BACKUP_AT,
    hosted,
  };
}

function shard(threads: Record<string, TeamsThread>): TeamsChannelShard {
  return {
    format_version: 1,
    team_id: TEAM_ID,
    channel_id: CHANNEL_ID,
    channel: { id: CHANNEL_ID, displayName: 'General' },
    members: [],
    tabs: [],
    read_mode: 'full',
    threads,
  };
}

describe('build_channel_index_entry', () => {
  it('counts threads, messages (root plus replies), and the size of every message blob', () => {
    const hosted = { 'hc-1': { storage_key: 'hc-1', checksum: 'sum-hc-1', size_bytes: 3 } };
    const with_reply: TeamsThread = {
      root: message_ref('root-1', 10, hosted),
      replies: { 'reply-1': message_ref('reply-1', 5) },
    };
    const root_only: TeamsThread = { root: message_ref('root-2', 7), replies: {} };

    const entry = build_channel_index_entry(shard({ 'root-1': with_reply, 'root-2': root_only }), {
      storage_key: 'shard-key',
      checksum: 'shard-sum',
      size_bytes: 99,
    });

    expect(entry).toEqual({
      channel_id: CHANNEL_ID,
      display_name: 'General',
      shard_key: 'shard-key',
      shard_checksum: 'shard-sum',
      thread_count: 2,
      message_count: 3,
      size_bytes: 25,
    });
  });

  it('leaves display_name undefined when the channel has no string name', () => {
    const entry = build_channel_index_entry(
      { ...shard({}), channel: { id: CHANNEL_ID } },
      { storage_key: 'shard-key', checksum: 'shard-sum', size_bytes: 1 },
    );

    expect(entry.display_name).toBeUndefined();
    expect(entry.thread_count).toBe(0);
    expect(entry.size_bytes).toBe(0);
  });
});

describe('build_team_index', () => {
  it('sets id from team and snapshot, format_version 1, and sums totals from the channels', () => {
    const channels = [
      {
        channel_id: 'channel-1',
        shard_key: 'a',
        shard_checksum: 'a',
        thread_count: 2,
        message_count: 5,
        size_bytes: 100,
      },
      {
        channel_id: 'channel-2',
        shard_key: 'b',
        shard_checksum: 'b',
        thread_count: 1,
        message_count: 1,
        size_bytes: 20,
      },
    ];

    const index = build_team_index({
      tenant_id: 'tenant-1',
      team_id: TEAM_ID,
      team_display_name: 'Team One',
      snapshot_id: 'snap-1',
      created_at: new Date(BACKUP_AT),
      team: { id: TEAM_ID },
      members: [],
      channels,
    });

    expect(index).toMatchObject({
      id: 'team-1-snap-1',
      format_version: 1,
      tenant_id: 'tenant-1',
      team_id: TEAM_ID,
      snapshot_id: 'snap-1',
      channels,
      totals: { thread_count: 3, message_count: 6, size_bytes: 120 },
    });
  });
});

describe('build_channel_cursor', () => {
  it('binds the cursor to the given shard key and carries the link and failed roots', () => {
    const cursor = build_channel_cursor({
      team_id: TEAM_ID,
      channel_id: CHANNEL_ID,
      delta_link: 'link-1',
      baseline_shard_key: 'shard-key',
      failed_roots: {},
      updated_at: BACKUP_AT,
    });

    expect(cursor).toEqual({
      format_version: 1,
      team_id: TEAM_ID,
      channel_id: CHANNEL_ID,
      delta_link: 'link-1',
      baseline_shard_key: 'shard-key',
      failed_roots: {},
      updated_at: BACKUP_AT,
    });
  });
});
