import { describe, expect, it } from 'vitest';
import type { TeamsChannelEntry, TeamsGraphResource } from '@wisecom/atlas-types';
import {
  merge_channel_entries,
  split_owned_channels,
} from '@/services/backup/channel-entry-merger';

const BACKUP_AT = '2025-01-01T00:00:00.000Z';

function entry(id: string, overrides: Partial<TeamsChannelEntry> = {}): TeamsChannelEntry {
  return {
    id,
    channel: { id },
    members: [],
    tabs: [],
    read_mode: 'full',
    threads: {},
    ...overrides,
  };
}

describe('merge_channel_entries', () => {
  it('uses the entry this run processed over the previous one for a listed channel', () => {
    const processed = new Map([['channel-1', entry('channel-1', { read_mode: 'delta' })]]);

    const merged = merge_channel_entries({
      channels: [{ id: 'channel-1' }],
      processed,
      previous: [entry('channel-1')],
      backup_at: BACKUP_AT,
    });

    expect(merged).toEqual([entry('channel-1', { read_mode: 'delta' })]);
  });

  it('keeps the previous entry of a listed channel this run did not process', () => {
    const previous = entry('channel-2');

    const merged = merge_channel_entries({
      channels: [{ id: 'channel-2' }],
      processed: new Map(),
      previous: [previous],
      backup_at: BACKUP_AT,
    });

    expect(merged).toEqual([previous]);
  });

  it('keeps a previous channel Graph no longer lists, marked deleted at this run', () => {
    const merged = merge_channel_entries({
      channels: [],
      processed: new Map(),
      previous: [entry('channel-gone')],
      backup_at: BACKUP_AT,
    });

    expect(merged).toEqual([entry('channel-gone', { deleted_at: BACKUP_AT })]);
  });

  it('keeps an earlier deleted_at rather than moving it to this run', () => {
    const earlier = '2024-06-01T00:00:00.000Z';

    const merged = merge_channel_entries({
      channels: [],
      processed: new Map(),
      previous: [entry('channel-gone', { deleted_at: earlier })],
      backup_at: BACKUP_AT,
    });

    expect(merged[0]?.deleted_at).toBe(earlier);
  });

  it('omits a listed channel that has no entry at all', () => {
    const merged = merge_channel_entries({
      channels: [{ id: 'channel-new' }],
      processed: new Map(),
      previous: undefined,
      backup_at: BACKUP_AT,
    });

    expect(merged).toEqual([]);
  });
});

describe('split_owned_channels', () => {
  const TENANT = 'tenant-1';

  it('keeps channels with no foreign owner and skips a channel owned by another tenant', () => {
    const channels: TeamsGraphResource[] = [
      { id: 'channel-1' },
      { id: 'channel-2', tenantId: 'tenant-2' },
    ];

    const { owned, warnings } = split_owned_channels(channels, TENANT);

    expect(owned.map((c) => c.id)).toEqual(['channel-1']);
    expect(warnings).toEqual(['Channel channel-2 is owned by another tenant; skipped']);
  });

  it('treats a tenant id that differs only in case as the same tenant', () => {
    const { owned, warnings } = split_owned_channels(
      [{ id: 'channel-1', tenantId: 'TENANT-1' }],
      TENANT,
    );

    expect(owned.map((c) => c.id)).toEqual(['channel-1']);
    expect(warnings).toEqual([]);
  });
});
