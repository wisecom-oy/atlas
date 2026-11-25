import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError, ThrottledError, type FailedItemLedger } from '@wisecom/atlas-types';
import { apply_root_changes, type ChannelRootRead } from './channel-root-applier-harness';
import { store_thread } from '@/services/backup/thread-store';
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

/**
 * Issue #881: a root that fails on a Graph outage fails the channel, which keeps its checkpoint.
 * Recording it as a failed root would spend a ledger attempt on every root left in the channel.
 */

const DELTA: ChannelRootRead = { changes: [], link: 'link-2', is_full: false };

const OUTAGES = [
  [
    'GraphUnavailableError',
    () => new GraphUnavailableError('Graph unavailable', { retries: 12, elapsed_ms: 1_411_000 }),
  ],
  ['ThrottledError', () => new ThrottledError('Graph kept throttling', 30_000)],
] as const;

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

function rejecting_connector(err: unknown) {
  return make_connector({
    get_channel_message: vi.fn(async () => {
      throw err;
    }),
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
});

describe('apply_root_tasks during a Graph outage', () => {
  it.each(OUTAGES)('fails the channel when a changed root ends in %s', async (_, make) => {
    const outage = make();
    vi.mocked(store_thread).mockRejectedValueOnce(outage);
    const ledger: FailedItemLedger = {};

    const applying = apply_root_changes(
      make_scope(make_connector()),
      'channel-1',
      { ...DELTA, changes: [root_change('m1'), root_change('m2')] },
      {},
      ledger,
      {},
    );

    await expect(applying).rejects.toBe(outage);
    expect(ledger).toEqual({});
  });

  it.each(OUTAGES)('spends no ledger attempt when a retried root ends in %s', async (_, make) => {
    const outage = make();
    const ledger = ledger_failure('m9', 1);

    const applying = apply_root_changes(
      make_scope(rejecting_connector(outage)),
      'channel-1',
      DELTA,
      {},
      ledger,
      {},
    );

    await expect(applying).rejects.toBe(outage);
    expect(ledger.m9?.attempts).toBe(1);
  });

  it('still records a failure of one root as a failed root', async () => {
    const out = await apply_root_changes(
      make_scope(rejecting_connector(Object.assign(new Error('bad request'), { statusCode: 500 }))),
      'channel-1',
      DELTA,
      {},
      ledger_failure('m9', 1),
      {},
    );

    expect(out.failed_roots.m9?.attempts).toBe(2);
    expect(out.errors).toHaveLength(1);
  });
});
