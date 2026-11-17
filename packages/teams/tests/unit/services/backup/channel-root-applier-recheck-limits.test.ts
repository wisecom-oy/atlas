import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamsThread } from '@wisecom/atlas-types';
import { apply_root_changes, type ChannelRootRead } from './channel-root-applier-harness';
import { MAX_FAILED_ITEM_ATTEMPTS } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { MAX_HOSTED_RECHECK_ATTEMPTS } from '@/services/backup/hosted-recheck';
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

const DELTA: ChannelRootRead = { changes: [], link: 'link-2', is_full: false };
const FULL: ChannelRootRead = { changes: [root_change('m1')], link: 'link-3', is_full: true };
const GONE = vi.fn(async () => ({ status: 'not_found' as const }));

/** A stored thread whose root still lists one hosted item Graph did not return. */
function thread_missing_hosted(id: string): TeamsThread {
  const thread = thread_entry(id);
  return { ...thread, root: { ...thread.root, hosted_missing: ['h1'] } };
}

beforeEach(() => {
  GONE.mockClear();
  vi.mocked(store_thread).mockReset();
  vi.mocked(store_thread).mockImplementation(async (_scope, _channel, _previous, root) => ({
    thread: thread_missing_hosted(root.id),
    warnings: [],
    stored: 0,
    deduped: 0,
  }));
});

describe('recheck root that Graph no longer returns (Q1)', () => {
  it('advances the recheck and records no ledger failure on a 404 re-read', async () => {
    const connector = make_connector({ get_channel_message: GONE });

    const out = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      DELTA,
      { m1: thread_missing_hosted('m1') },
      {},
      { m1: 1 },
    );

    expect(out.hosted_recheck).toEqual({ m1: 2 });
    expect(out.failed_roots).toEqual({});
    expect(out.errors).toEqual([]);
  });

  it('does not re-fetch a recheck root that already reached the limit', async () => {
    const connector = make_connector({ get_channel_message: GONE });

    const out = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      DELTA,
      { m1: thread_missing_hosted('m1') },
      {},
      { m1: MAX_HOSTED_RECHECK_ATTEMPTS },
    );

    expect(GONE).not.toHaveBeenCalled();
    expect(out.hosted_recheck).toEqual({ m1: MAX_HOSTED_RECHECK_ATTEMPTS });
  });

  it('does not re-fetch a recheck root that has an exhausted failure record (S1)', async () => {
    const connector = make_connector({ get_channel_message: GONE });
    const exhausted = {
      m1: {
        item_id: 'm1',
        drive_id: 'channel-1',
        name: 'm1',
        reason: 'boom',
        attempts: MAX_FAILED_ITEM_ATTEMPTS,
        first_failed_at: '2024-01-01T00:00:00.000Z',
        last_failed_at: '2024-01-01T00:00:00.000Z',
      },
    };

    await apply_root_changes(
      make_scope(connector),
      'channel-1',
      DELTA,
      { m1: thread_missing_hosted('m1') },
      exhausted,
      { m1: 1 },
    );

    expect(GONE).not.toHaveBeenCalled();
  });
});

describe('recheck limit on a full-read channel (Q2)', () => {
  it('keeps the limit across full reads and warns only when it is first reached', async () => {
    const connector = make_connector();

    const first = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      FULL,
      { m1: thread_missing_hosted('m1') },
      {},
      { m1: MAX_HOSTED_RECHECK_ATTEMPTS - 1 },
    );
    const second = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      FULL,
      { m1: thread_missing_hosted('m1') },
      {},
      first.hosted_recheck,
    );

    expect(first.hosted_recheck).toEqual({ m1: MAX_HOSTED_RECHECK_ATTEMPTS });
    expect(first.warnings).toContainEqual(expect.stringContaining('gave up re-checking'));
    expect(second.hosted_recheck).toEqual({ m1: MAX_HOSTED_RECHECK_ATTEMPTS });
    expect(second.warnings).not.toContainEqual(expect.stringContaining('gave up re-checking'));
  });
});
