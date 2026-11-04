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

vi.mock('@/services/backup/thread-store', () => ({ store_thread: vi.fn() }));

const BACKUP_AT = '2025-01-01T00:00:00.000Z';
const CHANNEL: TeamsGraphResource = { id: 'channel-1', displayName: 'General' };
const CHANNEL_WITH_EMAIL: TeamsGraphResource = {
  id: 'channel-1',
  displayName: 'General',
  email: 'general@example.invalid',
};

function root_change(id: string, deleted = false): TeamsRootChange {
  return { root: { id }, deleted };
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
    fetch_message_delta: vi.fn(async () => ({ roots: [], delta_link: 'link-default' })),
    list_channel_messages: vi.fn(async () => []),
    ...overrides,
  } as unknown as TeamsConnector;
}

function make_scope(connector: TeamsConnector, should_interrupt = (): boolean => false) {
  const scope: BackupRunScope = {
    ctx: {} as TenantContext,
    connector,
    tenant_id: 'tenant-1',
    team_id: 'team-1',
    backup_at: BACKUP_AT,
    counters: create_backup_counters(),
    should_interrupt,
  };
  return scope;
}

describe('backup_channel', () => {
  beforeEach(() => {
    vi.mocked(store_thread).mockReset();
    vi.mocked(store_thread).mockImplementation(async (_scope, _channel, root) =>
      thread_entry(root.id),
    );
  });

  it('reads the whole channel without delta when the channel has no email', async () => {
    const connector = make_connector({
      list_channel_messages: vi.fn(async () => [root_change('msg-1')]),
    });
    const out = await backup_channel(make_scope(connector), CHANNEL, undefined, undefined);
    expect(out?.entry.read_mode).toBe('full');
    expect(out?.next_link).toBeUndefined();
    expect(connector.fetch_message_delta).not.toHaveBeenCalled();
    expect(Object.keys(out?.entry.threads ?? {})).toEqual(['msg-1']);
  });

  it('stores the delta link and reads changes by delta when the channel has an email', async () => {
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({
        roots: [root_change('msg-1')],
        delta_link: 'link-2',
      })),
    });
    const out = await backup_channel(
      make_scope(connector),
      CHANNEL_WITH_EMAIL,
      undefined,
      'link-1',
    );
    expect(out?.entry.read_mode).toBe('delta');
    expect(out?.next_link).toBe('link-2');
    expect(connector.fetch_message_delta).toHaveBeenCalledWith(
      'tenant-1',
      'team-1',
      'channel-1',
      'link-1',
    );
  });

  it('falls back to a full read when Graph rejects the delta link with 400', async () => {
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => {
        throw Object.assign(new Error('Bad Request'), { statusCode: 400 });
      }),
      list_channel_messages: vi.fn(async () => [root_change('msg-1')]),
    });
    const scope = make_scope(connector);
    const out = await backup_channel(scope, CHANNEL_WITH_EMAIL, undefined, 'stale');
    expect(out?.entry.read_mode).toBe('full');
    expect(out?.next_link).toBeUndefined();
    expect(scope.counters.channels_full_read).toBe(1);
  });

  it('rethrows delta errors that are not a rejected link', async () => {
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => {
        throw Object.assign(new Error('Too Many Requests'), { statusCode: 429 });
      }),
    });
    await expect(
      backup_channel(make_scope(connector), CHANNEL_WITH_EMAIL, undefined, 'link-1'),
    ).rejects.toThrow('Too Many Requests');
  });

  it('marks a previous root that a full read no longer lists as deleted', async () => {
    const connector = make_connector({ list_channel_messages: vi.fn(async () => []) });
    const previous = previous_channel({ 'msg-old': thread_entry('msg-old') });
    const scope = make_scope(connector);
    const out = await backup_channel(scope, CHANNEL, previous, undefined);
    expect(out?.entry.threads['msg-old']?.deleted_at).toBe(BACKUP_AT);
    expect(scope.counters.threads_deleted).toBe(1);
  });

  it('keeps a previous root on a delta read that does not mention it', async () => {
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({ roots: [], delta_link: 'link-2' })),
    });
    const previous = previous_channel({ 'msg-old': thread_entry('msg-old') });
    const out = await backup_channel(make_scope(connector), CHANNEL_WITH_EMAIL, previous, 'link-1');
    expect(out?.entry.threads['msg-old']?.deleted_at).toBeUndefined();
  });

  it('returns undefined when the run is interrupted mid-channel', async () => {
    const connector = make_connector({
      list_channel_messages: vi.fn(async () => [root_change('msg-1')]),
    });
    const out = await backup_channel(
      make_scope(connector, () => true),
      CHANNEL,
      undefined,
      undefined,
    );
    expect(out).toBeUndefined();
    expect(store_thread).not.toHaveBeenCalled();
  });
});
