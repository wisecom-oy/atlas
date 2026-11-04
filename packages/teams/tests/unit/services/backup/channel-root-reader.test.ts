import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { TeamsConnector, TeamsRootChange, TenantContext } from '@wisecom/atlas-types';
import { read_channel_roots } from '@/services/backup/channel-root-reader';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';

function root(id: string, deleted = false): TeamsRootChange {
  return { root: { id, displayName: id }, deleted };
}

function make_scope(connector: Partial<TeamsConnector>): BackupRunScope {
  return {
    ctx: {} as TenantContext,
    connector: connector as TeamsConnector,
    tenant_id: 'tenant-1',
    team_id: 'team-1',
    backup_at: '2025-01-01T00:00:00.000Z',
    counters: create_backup_counters(),
    should_interrupt: () => false,
    force_full: false,
  };
}

const EMAIL_CHANNEL = { id: 'channel-1', email: 'channel-1@example.test' };
const NO_EMAIL_CHANNEL = { id: 'channel-2' };

describe('read_channel_roots', () => {
  let fetch_message_delta: Mock;
  let list_channel_messages: Mock;

  beforeEach(() => {
    fetch_message_delta = vi.fn(async () => ({ roots: [root('root-1')], delta_link: 'link-new' }));
    list_channel_messages = vi.fn(async () => [root('root-1'), root('root-2')]);
  });

  it('reads incrementally from the stored link when the channel has an email address', async () => {
    const read = await read_channel_roots(
      make_scope({ fetch_message_delta, list_channel_messages }),
      EMAIL_CHANNEL,
      'link-old',
    );

    expect(fetch_message_delta).toHaveBeenCalledWith('tenant-1', 'team-1', 'channel-1', 'link-old');
    expect(list_channel_messages).not.toHaveBeenCalled();
    expect(read).toEqual({ changes: [root('root-1')], link: 'link-new', is_full: false });
  });

  it('reads every root in full, with no link, for a channel without an email address', async () => {
    const read = await read_channel_roots(
      make_scope({ fetch_message_delta, list_channel_messages }),
      NO_EMAIL_CHANNEL,
      'link-old',
    );

    expect(fetch_message_delta).not.toHaveBeenCalled();
    expect(read.link).toBeUndefined();
    expect(read.is_full).toBe(true);
    expect(read.changes.map((c) => c.root.id)).toEqual(['root-1', 'root-2']);
  });

  it('takes a full read and a delta link when there is no stored link yet', async () => {
    const read = await read_channel_roots(
      make_scope({ fetch_message_delta, list_channel_messages }),
      EMAIL_CHANNEL,
      undefined,
    );

    expect(fetch_message_delta).toHaveBeenCalledWith('tenant-1', 'team-1', 'channel-1', undefined);
    expect(read.link).toBe('link-new');
    expect(read.is_full).toBe(true);
  });

  it('keeps the delta version of a root that both reads return', async () => {
    fetch_message_delta.mockResolvedValueOnce({
      roots: [root('root-1', true)],
      delta_link: 'link-new',
    });

    const read = await read_channel_roots(
      make_scope({ fetch_message_delta, list_channel_messages }),
      EMAIL_CHANNEL,
      undefined,
    );

    expect(read.changes.find((c) => c.root.id === 'root-1')?.deleted).toBe(true);
    expect(read.changes.map((c) => c.root.id).sort()).toEqual(['root-1', 'root-2']);
  });

  it('falls back to a full read when Graph rejects the stored delta link with a 400', async () => {
    fetch_message_delta
      .mockRejectedValueOnce(Object.assign(new Error('bad sync state'), { statusCode: 400 }))
      .mockResolvedValueOnce({ roots: [root('root-1')], delta_link: 'link-fresh' });

    const read = await read_channel_roots(
      make_scope({ fetch_message_delta, list_channel_messages }),
      EMAIL_CHANNEL,
      'link-stale',
    );

    expect(fetch_message_delta).toHaveBeenNthCalledWith(
      2,
      'tenant-1',
      'team-1',
      'channel-1',
      undefined,
    );
    expect(read.is_full).toBe(true);
    expect(read.link).toBe('link-fresh');
  });

  it('rethrows a delta failure that is not a 400', async () => {
    fetch_message_delta.mockRejectedValueOnce(
      Object.assign(new Error('server down'), { statusCode: 500 }),
    );

    await expect(
      read_channel_roots(
        make_scope({ fetch_message_delta, list_channel_messages }),
        EMAIL_CHANNEL,
        'link-old',
      ),
    ).rejects.toThrow('server down');
    expect(list_channel_messages).not.toHaveBeenCalled();
  });
});
