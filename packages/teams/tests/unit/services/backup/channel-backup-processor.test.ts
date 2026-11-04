import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TeamsChannelEntry,
  TeamsConnector,
  TeamsGraphResource,
  TeamsRootChange,
  TeamsThreadEntry,
} from '@wisecom/atlas-types';
import type { TenantContext } from '@wisecom/atlas-types';
import { backup_channel } from '@/services/backup/channel-backup-processor';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';
import { store_thread } from '@/services/backup/thread-store';

vi.mock('@/services/backup/thread-store', () => ({
  store_thread: vi.fn(),
  mark_thread_removed: vi.fn(),
}));

const BACKUP_AT = '2025-01-01T00:00:00.000Z';
const CHANNEL: TeamsGraphResource = { id: 'channel-1', displayName: 'General' };
const CHANNEL_WITH_EMAIL = {
  id: 'channel-1',
  displayName: 'General',
  email: 'general@example.invalid',
} as TeamsGraphResource;
const SHARED_CHANNEL = {
  id: 'channel-1',
  displayName: 'Shared',
  email: 'shared@example.invalid',
  membershipType: 'shared',
} as TeamsGraphResource;

function root_change(id: string): TeamsRootChange {
  return { root: { id }, deleted: false };
}

function thread_entry(id: string): TeamsThreadEntry {
  return {
    storage_key: `key-${id}`,
    checksum: `sum-${id}`,
    size_bytes: 1,
    last_modified_at: BACKUP_AT,
    reply_count: 0,
    hosted: {},
    backup_at: BACKUP_AT,
  };
}

function previous_channel(threads: Record<string, TeamsThreadEntry>): TeamsChannelEntry {
  return {
    id: 'channel-1',
    channel: CHANNEL,
    members: [],
    tabs: [],
    read_mode: 'full',
    threads,
  };
}

function make_connector(overrides: Partial<TeamsConnector> = {}): TeamsConnector {
  return {
    list_channel_members: vi.fn(async () => []),
    list_channel_tabs: vi.fn(async () => []),
    get_channel_files_folder: vi.fn(async () => undefined),
    list_channel_shared_teams: vi.fn(async () => []),
    fetch_message_delta: vi.fn(async () => ({ roots: [], delta_link: 'link-default' })),
    list_channel_messages: vi.fn(async () => []),
    ...overrides,
  } as unknown as TeamsConnector;
}

function make_scope(
  connector: TeamsConnector,
  should_interrupt = (): boolean => false,
  force_full = false,
): BackupRunScope {
  return {
    ctx: {} as TenantContext,
    connector,
    tenant_id: 'tenant-1',
    team_id: 'team-1',
    backup_at: BACKUP_AT,
    counters: create_backup_counters(),
    should_interrupt,
    force_full,
  };
}

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

    expect(connector.list_channel_messages).toHaveBeenCalledWith('tenant-1', 'team-1', 'channel-1');
    expect(connector.fetch_message_delta).toHaveBeenCalledWith(
      'tenant-1',
      'team-1',
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
      'team-1',
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
    expect(Object.keys(failed.failed_roots)).toEqual(['root-1']);

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
      list_channel_shared_teams: vi.fn(async () => [{ id: 'team-2', displayName: 'Other' }]),
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
      'team-1',
      'channel-1',
    );
    expect(out.entry.shared_with_teams).toEqual([{ id: 'team-2', displayName: 'Other' }]);
    expect(plain.entry.shared_with_teams).toBeUndefined();
  });

  it('reuses the stored files folder unless the run is a full run', async () => {
    const folder = { id: 'folder-1' } as unknown as TeamsChannelEntry['files_folder'];
    const previous: TeamsChannelEntry = { ...previous_channel({}), files_folder: folder };

    const reused_connector = make_connector();
    const reused = await backup_channel(
      make_scope(reused_connector),
      CHANNEL,
      previous,
      undefined,
      {},
    );
    expect(reused_connector.get_channel_files_folder).not.toHaveBeenCalled();
    expect(reused.entry.files_folder).toBe(folder);

    const full_connector = make_connector();
    await backup_channel(
      make_scope(full_connector, () => false, true),
      CHANNEL,
      previous,
      undefined,
      {},
    );
    expect(full_connector.get_channel_files_folder).toHaveBeenCalledTimes(1);
  });
});
