import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FailedItemLedger, TeamsThread } from '@wisecom/atlas-types';
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

/** A stored thread whose root still lists one hosted item Graph did not return. */
function thread_missing_hosted(id: string): TeamsThread {
  const thread = thread_entry(id);
  return { ...thread, root: { ...thread.root, hosted_missing: ['h1'] } };
}

function ledger_failure(root_id: string, attempts: number): FailedItemLedger {
  return {
    [root_id]: {
      item_id: root_id,
      drive_id: 'channel-1',
      name: root_id,
      reason: 'earlier',
      attempts,
      first_failed_at: BACKUP_AT,
      last_failed_at: BACKUP_AT,
    },
  };
}

function found_connector(root_id: string) {
  return make_connector({
    get_channel_message: vi.fn(async () => ({
      status: 'found' as const,
      change: root_change(root_id),
    })),
  });
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
});

describe('interrupted root fetch (P4)', () => {
  it('reports an interrupted re-read as interrupted, with no root failure or error', async () => {
    let interrupted = false;
    const connector = make_connector({
      get_channel_message: vi.fn(async () => {
        interrupted = true;
        throw new Error('aborted');
      }),
    });

    const out = await apply_root_changes(
      make_scope(connector, () => interrupted),
      'channel-1',
      DELTA,
      {},
      ledger_failure('m9', 1),
      {},
    );

    expect(out.interrupted).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.failed_roots.m9?.attempts).toBe(1);
  });
});

describe('hosted content recheck (P5)', () => {
  it('re-fetches a root whose hosted content is missing and counts the attempt', async () => {
    vi.mocked(store_thread).mockResolvedValue({
      thread: thread_missing_hosted('m1'),
      warnings: [],
      stored: 1,
      deduped: 0,
    });
    const first = await apply_root_changes(
      make_scope(make_connector()),
      'channel-1',
      { ...DELTA, changes: [root_change('m1')] },
      {},
      {},
      {},
    );
    expect(first.hosted_recheck).toEqual({ m1: 1 });

    const connector = found_connector('m1');
    const second = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      DELTA,
      first.threads,
      first.failed_roots,
      first.hosted_recheck,
    );

    expect(connector.get_channel_message).toHaveBeenCalledWith(
      'tenant-1',
      expect.any(String),
      'channel-1',
      'm1',
    );
    expect(second.hosted_recheck).toEqual({ m1: 2 });
    expect(second.warnings).toContainEqual(expect.stringContaining('attempt 2 of 5'));
    expect(second.failed_roots).toEqual({});
  });

  it('gives up after the fifth attempt and keeps the count at the limit', async () => {
    vi.mocked(store_thread).mockResolvedValue({
      thread: thread_missing_hosted('m1'),
      warnings: [],
      stored: 1,
      deduped: 0,
    });

    const out = await apply_root_changes(
      make_scope(found_connector('m1')),
      'channel-1',
      DELTA,
      {},
      {},
      { m1: 4 },
    );

    expect(out.hosted_recheck).toEqual({ m1: 5 });
    expect(out.warnings).toContainEqual(expect.stringContaining('gave up re-checking'));
  });

  it('drops a root from the recheck once its hosted content is complete', async () => {
    const out = await apply_root_changes(
      make_scope(found_connector('m1')),
      'channel-1',
      DELTA,
      {},
      {},
      { m1: 2 },
    );

    expect(out.hosted_recheck).toEqual({});
  });
});

describe('404 on root re-read (P6)', () => {
  it('keeps the stored root and counts an attempt instead of tombstoning it', async () => {
    const previous = { m9: thread_entry('m9') };
    const connector = make_connector({
      get_channel_message: vi.fn(async () => ({ status: 'not_found' as const })),
    });

    const out = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      DELTA,
      previous,
      ledger_failure('m9', 1),
      {},
    );

    expect(mark_root_removed).not.toHaveBeenCalled();
    expect(out.threads.m9).toEqual(thread_entry('m9'));
    expect(out.failed_roots.m9?.attempts).toBe(2);
    expect(out.warnings).toContainEqual(expect.stringContaining('404'));
    expect(out.interrupted).toBe(false);
  });
});
