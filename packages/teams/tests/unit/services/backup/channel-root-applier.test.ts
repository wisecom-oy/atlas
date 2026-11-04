import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FailedItemLedger,
  TeamsRootChange,
  TeamsThreadEntry,
  TenantContext,
} from '@wisecom/atlas-types';
import { MAX_FAILED_ITEM_ATTEMPTS } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';
import type { ChannelRootRead } from '@/services/backup/channel-root-reader';
import { apply_root_changes } from '@/services/backup/channel-root-applier';
import { mark_thread_removed, store_thread } from '@/services/backup/thread-store';

vi.mock('@/services/backup/thread-store', () => ({
  store_thread: vi.fn(),
  mark_thread_removed: vi.fn(),
}));

const BACKUP_AT = '2025-01-01T00:00:00.000Z';

function thread(id: string): TeamsThreadEntry {
  return {
    storage_key: `${id}-key`,
    checksum: `${id}-checksum`,
    size_bytes: 1,
    last_modified_at: '',
    reply_count: 0,
    hosted: {},
    backup_at: BACKUP_AT,
  };
}

function live(id: string): TeamsRootChange {
  return { root: { id }, deleted: false };
}

function scope_with(should_interrupt = (): boolean => false): BackupRunScope {
  return {
    ctx: {} as TenantContext,
    connector: {} as BackupRunScope['connector'],
    tenant_id: 'tenant-1',
    team_id: '00000000-0000-0000-0000-000000000001',
    backup_at: BACKUP_AT,
    counters: create_backup_counters(),
    should_interrupt,
    force_full: false,
  };
}

function delta_read(changes: TeamsRootChange[]): ChannelRootRead {
  return { changes, link: 'link-new', is_full: false };
}

function full_read(changes: TeamsRootChange[]): ChannelRootRead {
  return { changes, link: 'link-new', is_full: true };
}

describe('apply_root_changes', () => {
  beforeEach(() => {
    vi.mocked(store_thread).mockReset();
    vi.mocked(mark_thread_removed).mockReset();
    vi.mocked(store_thread).mockImplementation(async (_scope, _channel, change) =>
      thread(change.root.id),
    );
    vi.mocked(mark_thread_removed).mockImplementation((_scope, previous) => ({
      ...previous,
      deleted_at: BACKUP_AT,
    }));
  });

  it('keeps a failed root at its previous entry and records it in the ledger', async () => {
    vi.mocked(store_thread).mockRejectedValueOnce(new Error('upload refused'));
    const previous = { 'root-1': thread('old') };

    const out = await apply_root_changes(
      scope_with(),
      'channel-1',
      delta_read([live('root-1')]),
      previous,
      {},
    );

    expect(out.threads['root-1']).toEqual(thread('old'));
    expect(out.failed_roots['channel-1/root-1']).toMatchObject({
      item_id: 'channel-1/root-1',
      drive_id: 'channel-1',
      reason: 'upload refused',
      attempts: 1,
    });
    expect(out.errors).toEqual(['Channel channel-1 root root-1: upload refused']);
  });

  it('clears the ledger entry of a root that now succeeds', async () => {
    const ledger: FailedItemLedger = {
      'channel-1/root-1': {
        item_id: 'channel-1/root-1',
        drive_id: 'channel-1',
        name: 'root-1',
        reason: 'old failure',
        attempts: 2,
        first_failed_at: BACKUP_AT,
        last_failed_at: BACKUP_AT,
      },
    };

    const out = await apply_root_changes(
      scope_with(),
      'channel-1',
      delta_read([live('root-1')]),
      {},
      ledger,
    );

    expect(out.failed_roots).not.toHaveProperty('channel-1/root-1');
    expect(out.threads['root-1']).toEqual(thread('root-1'));
  });

  it('re-keys a legacy ledger entry to its channel and clears it once the root succeeds', async () => {
    const ledger: FailedItemLedger = {
      'root-1': {
        item_id: 'root-1',
        drive_id: 'channel-1',
        name: 'root-1',
        reason: 'old failure',
        attempts: 2,
        first_failed_at: BACKUP_AT,
        last_failed_at: BACKUP_AT,
      },
    };

    const out = await apply_root_changes(
      scope_with(),
      'channel-1',
      delta_read([live('root-1')]),
      {},
      ledger,
    );

    expect(out.failed_roots).toEqual({});
  });

  describe('ledger roots the delta read did not return', () => {
    const TEAM_ID = '00000000-0000-0000-0000-000000000001';

    function ledger_with(attempts: number): FailedItemLedger {
      return {
        'channel-1/root-1': {
          item_id: 'channel-1/root-1',
          drive_id: 'channel-1',
          name: 'root-1',
          reason: 'old failure',
          attempts,
          first_failed_at: BACKUP_AT,
          last_failed_at: BACKUP_AT,
        },
      };
    }

    function scope_fetching(get_channel_message: unknown): BackupRunScope {
      return {
        ...scope_with(),
        connector: { get_channel_message } as unknown as BackupRunScope['connector'],
      };
    }

    it('re-fetches a ledger root the delta read did not return and stores it', async () => {
      const get = vi.fn(async () => live('root-1'));

      const out = await apply_root_changes(
        scope_fetching(get),
        'channel-1',
        delta_read([]),
        {},
        ledger_with(1),
      );

      expect(get).toHaveBeenCalledWith('tenant-1', TEAM_ID, 'channel-1', 'root-1');
      expect(out.threads['root-1']).toEqual(thread('root-1'));
      expect(out.failed_roots).toEqual({});
    });

    it('marks a ledger root Graph no longer has as removed', async () => {
      const get = vi.fn(async () => undefined);

      const out = await apply_root_changes(
        scope_fetching(get),
        'channel-1',
        delta_read([]),
        { 'root-1': thread('old') },
        ledger_with(1),
      );

      expect(out.threads['root-1']).toMatchObject({ deleted_at: BACKUP_AT });
      expect(out.failed_roots).toEqual({});
    });

    it('counts another attempt when re-fetching a ledger root fails', async () => {
      const get = vi.fn(async () => {
        throw new Error('graph 500');
      });

      const out = await apply_root_changes(
        scope_fetching(get),
        'channel-1',
        delta_read([]),
        {},
        ledger_with(1),
      );

      expect(out.failed_roots['channel-1/root-1']).toMatchObject({ attempts: 2 });
      expect(out.errors).toEqual(['Channel channel-1 root root-1: graph 500']);
    });

    it('does not re-fetch a ledger root past the retry budget', async () => {
      const get = vi.fn(async () => live('root-1'));

      const out = await apply_root_changes(
        scope_fetching(get),
        'channel-1',
        delta_read([]),
        {},
        ledger_with(MAX_FAILED_ITEM_ATTEMPTS),
      );

      expect(get).not.toHaveBeenCalled();
      expect(out.failed_roots['channel-1/root-1']).toBeDefined();
    });

    it('does not re-fetch a ledger root the delta read already returned', async () => {
      const get = vi.fn(async () => live('root-1'));

      await apply_root_changes(
        scope_fetching(get),
        'channel-1',
        delta_read([live('root-1')]),
        {},
        ledger_with(1),
      );

      expect(get).not.toHaveBeenCalled();
    });
  });

  it('marks a previous root removed when a full read no longer lists it', async () => {
    const previous = { 'root-1': thread('root-1'), 'root-gone': thread('root-gone') };

    const out = await apply_root_changes(
      scope_with(),
      'channel-1',
      full_read([live('root-1')]),
      previous,
      {},
    );

    expect(mark_thread_removed).toHaveBeenCalledTimes(1);
    expect(out.threads['root-gone']?.deleted_at).toBe(BACKUP_AT);
    expect(out.threads['root-1']).toEqual(thread('root-1'));
  });

  it('keeps previous roots a delta read does not list, since a delta lists only changes', async () => {
    const previous = { 'root-gone': thread('root-gone') };

    const out = await apply_root_changes(
      scope_with(),
      'channel-1',
      delta_read([live('root-1')]),
      previous,
      {},
    );

    expect(mark_thread_removed).not.toHaveBeenCalled();
    expect(out.threads['root-gone']).toEqual(thread('root-gone'));
  });

  it('marks a deleted root removed without storing it', async () => {
    const previous = { 'root-1': thread('root-1') };
    const change: TeamsRootChange = { root: { id: 'root-1' }, deleted: true };

    const out = await apply_root_changes(
      scope_with(),
      'channel-1',
      delta_read([change]),
      previous,
      {},
    );

    expect(store_thread).not.toHaveBeenCalled();
    expect(out.threads['root-1']?.deleted_at).toBe(BACKUP_AT);
  });

  it('stores nothing for a deleted root that was never backed up', async () => {
    const change: TeamsRootChange = { root: { id: 'root-new' }, deleted: true };

    const out = await apply_root_changes(scope_with(), 'channel-1', delta_read([change]), {}, {});

    expect(store_thread).not.toHaveBeenCalled();
    expect(out.threads).not.toHaveProperty('root-new');
  });

  it('stops at an interruption and reports it without marking anything removed', async () => {
    let calls = 0;
    const scope = scope_with(() => {
      calls++;
      return calls > 1;
    });

    const out = await apply_root_changes(
      scope,
      'channel-1',
      full_read([live('root-1'), live('root-2')]),
      { 'root-gone': thread('root-gone') },
      {},
    );

    expect(out.interrupted).toBe(true);
    expect(store_thread).toHaveBeenCalledTimes(1);
    expect(mark_thread_removed).not.toHaveBeenCalled();
  });
});
