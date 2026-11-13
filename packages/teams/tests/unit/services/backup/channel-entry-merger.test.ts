import { describe, expect, it } from 'vitest';
import type { TeamsChannelIndexEntry, TeamsGraphResource } from '@wisecom/atlas-types';
import {
  all_channels_foreign_errors,
  merge_channel_entries,
  split_owned_channels,
} from '@/services/backup/channel-entry-merger';

const BACKUP_AT = '2025-01-01T00:00:00.000Z';
const EARLIER = '2024-06-01T00:00:00.000Z';

function index_entry(
  channel_id: string,
  overrides: Partial<TeamsChannelIndexEntry> = {},
): TeamsChannelIndexEntry {
  return {
    channel_id,
    shard_key: `shard-${channel_id}`,
    shard_checksum: `sum-${channel_id}`,
    thread_count: 1,
    message_count: 1,
    size_bytes: 1,
    ...overrides,
  };
}

describe('merge_channel_entries', () => {
  it('uses the entry this run processed over the previous one for a listed channel', () => {
    const processed = new Map([
      ['channel-1', index_entry('channel-1', { shard_key: 'new-shard' })],
    ]);

    const merged = merge_channel_entries({
      channels: [{ id: 'channel-1' }],
      processed,
      previous: [index_entry('channel-1')],
      backup_at: BACKUP_AT,
    });

    expect(merged).toEqual([index_entry('channel-1', { shard_key: 'new-shard' })]);
  });

  it('keeps the previous entry for a listed channel the run did not process, clearing deleted_at', () => {
    const merged = merge_channel_entries({
      channels: [{ id: 'channel-1' }],
      processed: new Map(),
      previous: [index_entry('channel-1', { deleted_at: EARLIER })],
      backup_at: BACKUP_AT,
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.shard_key).toBe('shard-channel-1');
    expect(merged[0]?.deleted_at).toBeUndefined();
  });

  it('drops a listed channel that has neither a processed nor a previous entry', () => {
    const merged = merge_channel_entries({
      channels: [{ id: 'channel-new' }],
      processed: new Map(),
      previous: undefined,
      backup_at: BACKUP_AT,
    });

    expect(merged).toEqual([]);
  });

  it('marks a previous channel Graph no longer lists as deleted at backup_at', () => {
    const merged = merge_channel_entries({
      channels: [],
      processed: new Map(),
      previous: [index_entry('channel-gone')],
      backup_at: BACKUP_AT,
    });

    expect(merged).toEqual([index_entry('channel-gone', { deleted_at: BACKUP_AT })]);
  });

  it('keeps the original deleted_at of a channel that was already removed', () => {
    const merged = merge_channel_entries({
      channels: [],
      processed: new Map(),
      previous: [index_entry('channel-gone', { deleted_at: EARLIER })],
      backup_at: BACKUP_AT,
    });

    expect(merged[0]?.deleted_at).toBe(EARLIER);
  });
});

describe('split_owned_channels', () => {
  it('keeps a channel with no owner tenant', () => {
    const channels: TeamsGraphResource[] = [{ id: 'channel-1' }];

    expect(split_owned_channels(channels, 'tenant-1')).toEqual({
      owned: channels,
      warnings: [],
    });
  });

  it('matches the owner tenant regardless of case', () => {
    const channels: TeamsGraphResource[] = [{ id: 'channel-1', tenantId: 'TENANT-1' }];

    expect(split_owned_channels(channels, 'tenant-1').owned).toEqual(channels);
  });

  it('skips a channel owned by another tenant with a warning', () => {
    const other: TeamsGraphResource = { id: 'channel-2', tenantId: 'tenant-2' };

    const split = split_owned_channels([{ id: 'channel-1' }, other], 'tenant-1');

    expect(split.owned).toEqual([{ id: 'channel-1' }]);
    expect(split.warnings).toEqual(['Channel channel-2 is owned by another tenant; skipped']);
  });
});

describe('all_channels_foreign_errors', () => {
  const OWNED: TeamsGraphResource = { id: 'channel-1' };
  const FOREIGN: TeamsGraphResource = {
    id: 'channel-2',
    tenantId: '11111111-2222-3333-4444-555555555555',
  };

  it('reports an error when every listed channel was skipped as foreign', () => {
    expect(all_channels_foreign_errors([FOREIGN], [], 'team-1')).toEqual([
      'Every channel of team team-1 is owned by another tenant; nothing was backed up',
    ]);
  });

  it('reports nothing when at least one channel is owned', () => {
    expect(all_channels_foreign_errors([OWNED, FOREIGN], [OWNED], 'team-1')).toEqual([]);
  });

  it('reports nothing when the team lists no channels at all', () => {
    expect(all_channels_foreign_errors([], [], 'team-1')).toEqual([]);
  });
});
