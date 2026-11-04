import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, type FailedItemLedger } from '@wisecom/atlas-types';
import { MAX_FAILED_ITEM_ATTEMPTS } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { apply_root_changes, type ChannelRootRead } from './channel-root-applier-harness';
import { mark_root_removed, store_thread } from '@/services/backup/thread-store';
import {
  BACKUP_AT,
  make_connector,
  make_scope,
  root_change,
  thread_entry,
} from './channel-backup-processor-harness';

vi.mock('@/services/backup/thread-store', () => ({
  store_thread: vi.fn(),
  mark_root_removed: vi.fn(),
}));

const DELTA: ChannelRootRead = { changes: [], link: 'link-2', is_full: false };
const FULL: ChannelRootRead = { changes: [], link: undefined, is_full: true };

function failure(item_id: string, attempts: number): FailedItemLedger[string] {
  return {
    item_id,
    drive_id: 'channel-1',
    name: item_id,
    reason: 'earlier',
    attempts,
    first_failed_at: BACKUP_AT,
    last_failed_at: BACKUP_AT,
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
  vi.mocked(mark_root_removed).mockReset();
  vi.mocked(mark_root_removed).mockImplementation((_scope, previous) => ({
    ...previous,
    deleted_at: BACKUP_AT,
  }));
});

describe('apply_root_changes stored roots', () => {
  it('stores each changed root and keeps untouched previous threads', async () => {
    const connector = make_connector();
    const previous = { m2: thread_entry('m2') };

    const out = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      { ...DELTA, changes: [root_change('m1')] },
      previous,
      {},
      {},
    );

    expect(Object.keys(out.threads).sort()).toEqual(['m1', 'm2']);
    expect(out.failed_roots).toEqual({});
    expect(out.interrupted).toBe(false);
  });

  it('fetches replies for a live root and none for a deleted root', async () => {
    const connector = make_connector({
      list_replies: vi.fn(async () => [{ id: 'r1' }]),
    });

    await apply_root_changes(
      make_scope(connector),
      'channel-1',
      {
        ...DELTA,
        changes: [
          root_change('m1'),
          { root: { id: 'm2', deletedDateTime: BACKUP_AT }, deleted: true },
        ],
      },
      {},
      {},
      {},
    );

    expect(connector.list_replies).toHaveBeenCalledTimes(1);
    expect(connector.list_replies).toHaveBeenCalledWith(
      'tenant-1',
      expect.any(String),
      'channel-1',
      'm1',
    );
    expect(vi.mocked(store_thread).mock.calls[1]?.[4]).toEqual([]);
  });

  it('marks a previous root removed on a full read when Graph no longer lists it', async () => {
    const scope = make_scope(make_connector());
    const previous = { m1: thread_entry('m1'), m2: thread_entry('m2') };

    const out = await apply_root_changes(
      scope,
      'channel-1',
      { ...FULL, changes: [root_change('m1')] },
      previous,
      {},
      {},
    );

    expect(out.threads.m2?.deleted_at).toBe(BACKUP_AT);
    expect(out.threads.m1?.deleted_at).toBeUndefined();
    expect(scope.counters.threads_deleted).toBe(1);
  });

  it('does not mark previous roots removed on a delta read', async () => {
    const out = await apply_root_changes(
      make_scope(make_connector()),
      'channel-1',
      DELTA,
      { m1: thread_entry('m1') },
      {},
      {},
    );

    expect(mark_root_removed).not.toHaveBeenCalled();
    expect(out.threads.m1?.deleted_at).toBeUndefined();
  });

  it('stops before the next root when the run is interrupted', async () => {
    const out = await apply_root_changes(
      make_scope(make_connector(), () => true),
      'channel-1',
      { ...DELTA, changes: [root_change('m1')] },
      {},
      {},
      {},
    );

    expect(out.interrupted).toBe(true);
    expect(store_thread).not.toHaveBeenCalled();
  });
});

describe('apply_root_changes failed-root ledger', () => {
  it('records a failing root with its error and increments its attempts on repeat', async () => {
    vi.mocked(store_thread).mockRejectedValueOnce(new Error('boom'));

    const out = await apply_root_changes(
      make_scope(make_connector()),
      'channel-1',
      { ...DELTA, changes: [root_change('m1')] },
      {},
      { m1: failure('m1', 2) },
      {},
    );

    expect(out.errors).toEqual(['Channel channel-1 root m1: boom']);
    expect(out.failed_roots.m1?.attempts).toBe(3);
  });

  it('clears a ledger root that a delta read applies successfully', async () => {
    const out = await apply_root_changes(
      make_scope(make_connector()),
      'channel-1',
      { ...DELTA, changes: [root_change('m1')] },
      {},
      { m1: failure('m1', 1) },
      {},
    );

    expect(out.failed_roots).toEqual({});
  });

  it('re-fetches a ledger root the delta read did not return', async () => {
    const connector = make_connector({
      get_channel_message: vi.fn(async () => ({
        status: 'found' as const,
        change: root_change('m9'),
      })),
    });

    const out = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      DELTA,
      {},
      { m9: failure('m9', 1) },
      {},
    );

    expect(connector.get_channel_message).toHaveBeenCalledWith(
      'tenant-1',
      expect.any(String),
      'channel-1',
      'm9',
    );
    expect(out.threads.m9).toBeDefined();
    expect(out.failed_roots).toEqual({});
  });

  it('does not re-fetch a ledger root that spent its attempt budget', async () => {
    const connector = make_connector({ get_channel_message: vi.fn() });

    const out = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      DELTA,
      {},
      { m9: failure('m9', MAX_FAILED_ITEM_ATTEMPTS) },
      {},
    );

    expect(connector.get_channel_message).not.toHaveBeenCalled();
    expect(out.failed_roots.m9).toBeDefined();
  });

  it('drops ledger roots a full read no longer lists (N7)', async () => {
    const connector = make_connector({ get_channel_message: vi.fn() });

    const out = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      { ...FULL, changes: [root_change('m1')] },
      {},
      { m1: failure('m1', 1), m9: failure('m9', 1) },
      {},
    );

    expect(out.failed_roots).toEqual({});
    expect(connector.get_channel_message).not.toHaveBeenCalled();
  });

  it('rethrows an AuthError from a root without recording it', async () => {
    vi.mocked(store_thread).mockRejectedValueOnce(new AuthError('denied'));

    await expect(
      apply_root_changes(
        make_scope(make_connector()),
        'channel-1',
        { ...DELTA, changes: [root_change('m1')] },
        {},
        {},
        {},
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
