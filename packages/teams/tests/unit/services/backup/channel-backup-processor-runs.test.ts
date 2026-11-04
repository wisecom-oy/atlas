import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TeamsChannelIndexEntry, TeamsGraphResource } from '@wisecom/atlas-types';
import { backup_channel, type ChannelStartState } from '@/services/backup/channel-backup-processor';
import { store_thread } from '@/services/backup/thread-store';
import {
  BACKUP_AT,
  CHANNEL,
  CHANNEL_WITH_EMAIL,
  make_connector,
  make_scope,
  previous_shard,
  root_change,
  thread_entry,
} from './channel-backup-processor-harness';

vi.mock('@/services/backup/thread-store', () => ({
  store_thread: vi.fn(),
  mark_root_removed: vi.fn(),
}));

const previous_entry: TeamsChannelIndexEntry = {
  channel_id: 'channel-1',
  shard_key: 'shard-key',
  shard_checksum: 'shard-sum',
  thread_count: 1,
  message_count: 1,
  size_bytes: 1,
  deleted_at: BACKUP_AT,
};

function start(overrides: Partial<ChannelStartState> = {}): ChannelStartState {
  return {
    previous_entry: undefined,
    previous_shard: undefined,
    stored_link: undefined,
    failed_roots: {},
    hosted_recheck: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(store_thread).mockReset();
  vi.mocked(store_thread).mockImplementation(async (_scope, _channel, _previous, root) => ({
    thread: thread_entry(root.id),
    warnings: [],
    stored: 1,
    deduped: 0,
  }));
});

describe('backup_channel read modes', () => {
  it('reads every root in full for a channel without a mail address, with no link', async () => {
    const connector = make_connector({
      list_channel_messages: vi.fn(async () => [root_change('m1')]),
    });

    const output = await backup_channel(make_scope(connector), CHANNEL, start());

    expect(connector.list_channel_messages).toHaveBeenCalledTimes(1);
    expect(connector.fetch_message_delta).not.toHaveBeenCalled();
    expect(output.shard.read_mode).toBe('full');
    expect(output.next_link).toBeUndefined();
    expect(Object.keys(output.shard.threads)).toEqual(['m1']);
  });

  it('follows the stored link for a channel with a mail address', async () => {
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({
        roots: [root_change('m2')],
        delta_link: 'link-2',
      })),
    });

    const output = await backup_channel(
      make_scope(connector),
      CHANNEL_WITH_EMAIL,
      start({ stored_link: 'stored-link' }),
    );

    expect(connector.fetch_message_delta).toHaveBeenCalledWith(
      'tenant-1',
      expect.any(String),
      'channel-1',
      'stored-link',
    );
    expect(output.shard.read_mode).toBe('delta');
    expect(output.next_link).toBe('link-2');
  });

  it('ignores the stored link on a --full run', async () => {
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({ roots: [], delta_link: 'link-fresh' })),
    });

    const output = await backup_channel(
      make_scope(connector, undefined, true),
      CHANNEL_WITH_EMAIL,
      start({ stored_link: 'stored-link' }),
    );

    expect(connector.fetch_message_delta).toHaveBeenCalledWith(
      'tenant-1',
      expect.any(String),
      'channel-1',
      undefined,
    );
    expect(output.shard.read_mode).toBe('full');
    expect(output.next_link).toBe('link-fresh');
  });

  it('falls back to a full read when Graph rejects the stored link', async () => {
    const connector = make_connector({
      fetch_message_delta: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 400 }))
        .mockResolvedValueOnce({ roots: [root_change('m1')], delta_link: 'link-new' }),
    });

    const output = await backup_channel(
      make_scope(connector),
      CHANNEL_WITH_EMAIL,
      start({ stored_link: 'stored-link' }),
    );

    expect(output.shard.read_mode).toBe('full');
    expect(output.next_link).toBe('link-new');
  });
});

describe('backup_channel retries and link retention', () => {
  it('keeps the stored link when a root fails, so the next run presents it again', async () => {
    vi.mocked(store_thread).mockRejectedValueOnce(new Error('boom'));
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({
        roots: [root_change('m1')],
        delta_link: 'link-2',
      })),
    });

    const output = await backup_channel(
      make_scope(connector),
      CHANNEL_WITH_EMAIL,
      start({ stored_link: 'stored-link' }),
    );

    expect(output.errors).toEqual(['Channel channel-1 root m1: boom']);
    expect(output.failed_roots).toEqual({
      m1: expect.objectContaining({ item_id: 'm1' }),
    });
    expect(output.next_link).toBe('stored-link');
  });

  it('retries a root that failed on an earlier run even when Graph did not return it', async () => {
    const earlier = {
      m9: {
        item_id: 'm9',
        drive_id: 'channel-1',
        name: 'm9',
        reason: 'earlier',
        attempts: 1,
        first_failed_at: BACKUP_AT,
        last_failed_at: BACKUP_AT,
      },
    };
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({ roots: [], delta_link: 'link-2' })),
      get_channel_message: vi.fn(async () => ({
        status: 'found' as const,
        change: root_change('m9'),
      })),
    });

    const output = await backup_channel(
      make_scope(connector),
      CHANNEL_WITH_EMAIL,
      start({ stored_link: 'stored-link', failed_roots: earlier }),
    );

    expect(connector.get_channel_message).toHaveBeenCalledWith(
      'tenant-1',
      expect.any(String),
      'channel-1',
      'm9',
    );
    expect(Object.keys(output.failed_roots)).toEqual([]);
    expect(output.next_link).toBe('link-2');
  });

  it('marks the run interrupted and keeps the stored link when the run stops mid-channel', async () => {
    let calls = 0;
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({
        roots: [root_change('m1'), root_change('m2')],
        delta_link: 'link-2',
      })),
    });

    const output = await backup_channel(
      make_scope(connector, () => ++calls > 1),
      CHANNEL_WITH_EMAIL,
      start({ stored_link: 'stored-link' }),
    );

    expect(output.interrupted).toBe(true);
    expect(output.next_link).toBe('stored-link');
  });
});

describe('backup_channel shard reuse', () => {
  it('reuses the previous entry when content is unchanged, even if the read mode differs', async () => {
    const prior = previous_shard({ m1: thread_entry('m1') }, 'full');
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({
        roots: [root_change('m1')],
        delta_link: 'link-2',
      })),
    });

    const output = await backup_channel(
      make_scope(connector),
      { ...CHANNEL_WITH_EMAIL },
      start({
        previous_entry,
        previous_shard: { ...prior, channel: CHANNEL_WITH_EMAIL as TeamsGraphResource },
        stored_link: 'stored-link',
      }),
    );

    expect(output.shard.read_mode).toBe('delta');
    expect(output.reused_entry).toEqual({ ...previous_entry, deleted_at: undefined });
  });

  it('returns no reused entry when a stored root changed content', async () => {
    const prior = previous_shard({ m1: thread_entry('m1') }, 'full');
    vi.mocked(store_thread).mockResolvedValueOnce({
      thread: { ...thread_entry('m1'), root: { ...thread_entry('m1').root, checksum: 'changed' } },
      warnings: [],
      stored: 1,
      deduped: 0,
    });
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({
        roots: [root_change('m1')],
        delta_link: 'link-2',
      })),
    });

    const output = await backup_channel(
      make_scope(connector),
      CHANNEL_WITH_EMAIL,
      start({
        previous_entry,
        previous_shard: { ...prior, channel: CHANNEL_WITH_EMAIL as TeamsGraphResource },
        stored_link: 'stored-link',
      }),
    );

    expect(output.reused_entry).toBeUndefined();
  });
});
