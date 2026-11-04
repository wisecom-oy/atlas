import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backup_channel } from '@/services/backup/channel-backup-processor';
import { store_thread } from '@/services/backup/thread-store';
import {
  CHANNEL,
  CHANNEL_WITH_EMAIL,
  SHARED_CHANNEL,
  make_connector,
  make_scope,
  previous_channel,
  root_change,
  thread_entry,
} from './channel-backup-processor-harness';

vi.mock('@/services/backup/thread-store', () => ({
  store_thread: vi.fn(),
  mark_thread_removed: vi.fn(),
}));

describe('backup_channel', () => {
  beforeEach(() => {
    vi.mocked(store_thread).mockReset();
    vi.mocked(store_thread).mockImplementation(async (_scope, _channel, root) =>
      thread_entry(root.root.id),
    );
  });

  it('reads every root in full and stores the delta link for a channel with an email', async () => {
    const connector = make_connector({
      list_channel_messages: vi.fn(async () => [root_change('root-1')]),
      fetch_message_delta: vi.fn(async () => ({ roots: [], delta_link: 'link-new' })),
    });

    const out = await backup_channel(
      make_scope(connector),
      CHANNEL_WITH_EMAIL,
      undefined,
      undefined,
      {},
    );

    expect(connector.list_channel_messages).toHaveBeenCalledWith(
      'tenant-1',
      '00000000-0000-0000-0000-000000000001',
      'channel-1',
    );
    expect(connector.fetch_message_delta).toHaveBeenCalledWith(
      'tenant-1',
      '00000000-0000-0000-0000-000000000001',
      'channel-1',
      undefined,
    );
    expect(out.next_link).toBe('link-new');
    expect(out.complete).toBe(true);
    expect(out.entry.read_mode).toBe('full');
    expect(Object.keys(out.entry.threads)).toEqual(['root-1']);
  });

  it('reads in full and stores no link for a channel without an email, even with a stored link', async () => {
    const connector = make_connector({
      list_channel_messages: vi.fn(async () => [root_change('root-1')]),
    });

    const out = await backup_channel(make_scope(connector), CHANNEL, undefined, 'link-old', {});

    expect(connector.fetch_message_delta).not.toHaveBeenCalled();
    expect(out.next_link).toBeUndefined();
    expect(out.entry.read_mode).toBe('full');
  });

  it('reads only the changes since the stored link for a channel with an email', async () => {
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({
        roots: [root_change('root-2')],
        delta_link: 'link-new',
      })),
    });

    const out = await backup_channel(
      make_scope(connector),
      CHANNEL_WITH_EMAIL,
      previous_channel({ 'root-1': thread_entry('root-1') }),
      'link-old',
      {},
    );

    expect(connector.fetch_message_delta).toHaveBeenCalledWith(
      'tenant-1',
      '00000000-0000-0000-0000-000000000001',
      'channel-1',
      'link-old',
    );
    expect(connector.list_channel_messages).not.toHaveBeenCalled();
    expect(out.entry.read_mode).toBe('delta');
    expect(out.entry.threads).toHaveProperty('root-1');
    expect(out.next_link).toBe('link-new');
  });

  it('keeps the previous entry and withholds the link when a root fails, then clears it on retry', async () => {
    const previous = thread_entry('root-1');
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({
        roots: [root_change('root-1')],
        delta_link: 'link-new',
      })),
    });
    vi.mocked(store_thread).mockRejectedValueOnce(new Error('boom'));

    const failed = await backup_channel(
      make_scope(connector),
      CHANNEL_WITH_EMAIL,
      previous_channel({ 'root-1': previous }),
      'link-old',
      {},
    );

    expect(failed.entry.threads['root-1']).toEqual(previous);
    expect(failed.errors).toEqual(['Channel channel-1 root root-1: boom']);
    expect(failed.complete).toBe(false);
    expect(failed.next_link).toBe('link-old');
    expect(Object.keys(failed.failed_roots)).toEqual(['channel-1/root-1']);

    const retried = await backup_channel(
      make_scope(connector),
      CHANNEL_WITH_EMAIL,
      previous_channel({ 'root-1': previous }),
      'link-old',
      failed.failed_roots,
    );

    expect(retried.errors).toEqual([]);
    expect(retried.complete).toBe(true);
    expect(retried.next_link).toBe('link-new');
    expect(retried.failed_roots).toEqual({});
  });

  it('keeps the previous link and entry when interrupted before any root is stored', async () => {
    const previous = thread_entry('root-1');
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({
        roots: [root_change('root-2')],
        delta_link: 'link-new',
      })),
    });

    const out = await backup_channel(
      make_scope(connector, () => true),
      CHANNEL_WITH_EMAIL,
      previous_channel({ 'root-1': previous }),
      'link-old',
      {},
    );

    expect(store_thread).not.toHaveBeenCalled();
    expect(out.interrupted).toBe(true);
    expect(out.complete).toBe(false);
    expect(out.next_link).toBe('link-old');
    expect(out.entry.threads).toEqual({ 'root-1': previous });
  });

  it('looks up shared teams only for a shared channel and stores them on the entry', async () => {
    const connector = make_connector({
      list_channel_shared_teams: vi.fn(async () => [
        { id: '00000000-0000-0000-0000-000000000002', displayName: 'Other' },
      ]),
    });

    const out = await backup_channel(
      make_scope(connector),
      SHARED_CHANNEL,
      undefined,
      undefined,
      {},
    );
    const plain = await backup_channel(make_scope(connector), CHANNEL, undefined, undefined, {});

    expect(connector.list_channel_shared_teams).toHaveBeenCalledTimes(1);
    expect(connector.list_channel_shared_teams).toHaveBeenCalledWith(
      'tenant-1',
      '00000000-0000-0000-0000-000000000001',
      'channel-1',
    );
    expect(out.entry.shared_with_teams).toEqual([
      { id: '00000000-0000-0000-0000-000000000002', displayName: 'Other' },
    ]);
    expect(plain.entry.shared_with_teams).toBeUndefined();
  });

  it('does not list members of a standard channel and marks them as the team members', async () => {
    const connector = make_connector();
    const standard = { ...CHANNEL, membershipType: 'standard' } as typeof CHANNEL;

    const out = await backup_channel(make_scope(connector), standard, undefined, undefined, {});

    expect(connector.list_channel_members).not.toHaveBeenCalled();
    expect(out.entry.members).toEqual([]);
    expect(out.entry.members_from_team).toBe(true);
  });
});
