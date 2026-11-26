import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  is_retry_exhausted,
  MAX_FAILED_ITEM_ATTEMPTS,
  record_item_failure,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { FailedItemLedger } from '@wisecom/atlas-types';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import { apply_root_changes, type ChannelRootRead } from './channel-root-applier-harness';
import { store_thread } from '@/services/backup/thread-store';
import {
  make_connector,
  make_scope,
  root_change,
  thread_entry,
} from './channel-backup-processor-harness';

vi.mock('@/services/backup/thread-store', () => ({
  store_thread: vi.fn(),
  mark_root_removed: vi.fn(),
}));

const CHANGED: ChannelRootRead = { changes: [root_change('m1')], link: 'link-2', is_full: false };
const RETRY_ONLY: ChannelRootRead = { changes: [], link: 'link-2', is_full: false };
const BAD_REQUEST = graph_error(400, 'BadRequest', 'Invalid request');

/** A ledger holding root m1 of channel-1 with this many attempts already spent. */
function ledger_with(attempts: number): FailedItemLedger {
  let ledger: FailedItemLedger = {};
  for (let i = 0; i < attempts; i++) {
    ledger = record_item_failure(ledger, {
      item_id: 'm1',
      drive_id: 'channel-1',
      name: 'm1',
      reason: 'earlier failure',
    });
  }
  return ledger;
}

beforeEach(() => {
  vi.mocked(store_thread).mockReset();
  vi.mocked(store_thread).mockImplementation(async (_scope, _channel, _previous, root) => ({
    thread: thread_entry(root.id),
    warnings: [],
    stored: 0,
    deduped: 0,
  }));
});

describe('a 400 on a root is a retryable failure (issue #896)', () => {
  it('counts an attempt for a 400 on the replies of a changed root, not a permanent skip', async () => {
    const connector = make_connector({ list_replies: vi.fn().mockRejectedValue(BAD_REQUEST) });

    const out = await apply_root_changes(make_scope(connector), 'channel-1', CHANGED, {}, {}, {});

    expect(out.failed_roots.m1).toMatchObject({ attempts: 1 });
    expect(out.failed_roots.m1?.permanent).toBeUndefined();
    expect(out.errors).toEqual([expect.stringMatching(/root m1: Graph 400.*BadRequest/)]);
  });

  it('counts another attempt for a 400 on a retried root re-read', async () => {
    const connector = make_connector({
      get_channel_message: vi.fn().mockRejectedValue(BAD_REQUEST),
    });

    const out = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      RETRY_ONLY,
      {},
      ledger_with(1),
      {},
    );

    expect(out.failed_roots.m1).toMatchObject({ attempts: 2 });
    expect(out.failed_roots.m1?.permanent).toBeUndefined();
    expect(out.errors).toHaveLength(1);
  });

  it('reads the root again on the next run and clears it from the ledger on success', async () => {
    const connector = make_connector({
      list_replies: vi.fn().mockRejectedValueOnce(BAD_REQUEST).mockResolvedValue([]),
      get_channel_message: vi.fn(async () => ({
        status: 'found' as const,
        change: root_change('m1'),
      })),
    });
    const first = await apply_root_changes(make_scope(connector), 'channel-1', CHANGED, {}, {}, {});

    const second = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      RETRY_ONLY,
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
    expect(second.failed_roots).toEqual({});
    expect(second.threads.m1).toEqual(thread_entry('m1'));
    expect(second.errors).toEqual([]);
  });

  it('gives a root up once a 400 spends its last attempt, and stops reading it', async () => {
    const connector = make_connector({
      get_channel_message: vi.fn().mockRejectedValue(BAD_REQUEST),
    });
    const exhausted = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      RETRY_ONLY,
      {},
      ledger_with(MAX_FAILED_ITEM_ATTEMPTS - 1),
      {},
    );
    const record = exhausted.failed_roots.m1;
    expect(record).toMatchObject({ attempts: MAX_FAILED_ITEM_ATTEMPTS });
    expect(record !== undefined && is_retry_exhausted(record)).toBe(true);

    vi.mocked(connector.get_channel_message).mockClear();
    await apply_root_changes(
      make_scope(connector),
      'channel-1',
      RETRY_ONLY,
      {},
      exhausted.failed_roots,
      {},
    );

    expect(connector.get_channel_message).not.toHaveBeenCalled();
  });

  it('moves a recheck root refused with 400 into the ledger as a retryable failure', async () => {
    const connector = make_connector({
      get_channel_message: vi.fn().mockRejectedValue(BAD_REQUEST),
    });

    const out = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      RETRY_ONLY,
      { m1: thread_entry('m1') },
      {},
      { m1: 1 },
    );

    expect(out.failed_roots.m1).toMatchObject({ attempts: 1 });
    expect(out.failed_roots.m1?.permanent).toBeUndefined();
    expect(out.threads.m1).toEqual(thread_entry('m1'));
  });

  it('still counts a 404 on the replies of a listed root as a miss with a warning', async () => {
    const connector = make_connector({
      list_replies: vi.fn().mockRejectedValue(graph_error(404, 'NotFound')),
    });

    const out = await apply_root_changes(make_scope(connector), 'channel-1', CHANGED, {}, {}, {});

    expect(out.failed_roots.m1).toMatchObject({ attempts: 1 });
    expect(out.failed_roots.m1?.permanent).toBeUndefined();
    expect(out.errors).toEqual([]);
    expect(out.warnings).toContainEqual(expect.stringContaining('404'));
  });
});
