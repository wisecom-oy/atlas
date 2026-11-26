import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describe_failed_items,
  MAX_FAILED_ITEM_ATTEMPTS,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { FailedItemLedger } from '@wisecom/atlas-types';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import { backup_channel, type ChannelStartState } from '@/services/backup/channel-backup-processor';
import { store_thread } from '@/services/backup/thread-store';
import {
  CHANNEL_WITH_EMAIL,
  make_connector,
  make_scope,
  root_change,
  thread_entry,
} from './channel-backup-processor-harness';

vi.mock('@/services/backup/thread-store', () => ({
  store_thread: vi.fn(),
  mark_root_removed: vi.fn(),
}));

const BAD_REQUEST = graph_error(400, 'BadRequest', 'Invalid request');
const FOUND_M1 = { status: 'found' as const, change: root_change('m1') };

function start(failed_roots: FailedItemLedger = {}): ChannelStartState {
  return {
    previous_entry: undefined,
    previous_shard: undefined,
    stored_link: 'stored-link',
    failed_roots,
    hosted_recheck: {},
  };
}

/** A delta read that returns these roots and the fresh link `link-2`. */
function delta_returning(roots: string[]) {
  return vi.fn(async () => ({ roots: roots.map(root_change), delta_link: 'link-2' }));
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

describe('backup_channel with a 400 on a thread (issue #896)', () => {
  it('holds the checkpoint back after one 400, then advances it once the next run reads the thread', async () => {
    const connector = make_connector({
      fetch_message_delta_page: delta_returning(['m1']),
      list_replies: vi.fn().mockRejectedValueOnce(BAD_REQUEST).mockResolvedValue([]),
      get_channel_message: vi.fn(async () => FOUND_M1),
    });

    const first = await backup_channel(make_scope(connector), CHANNEL_WITH_EMAIL, start());

    expect(first.next_link).toBe('stored-link');
    expect(first.failed_roots.m1).toMatchObject({ attempts: 1 });
    expect(describe_failed_items(first.failed_roots)).toEqual([
      expect.stringContaining(`will retry (attempt 1 of ${MAX_FAILED_ITEM_ATTEMPTS})`),
    ]);

    vi.mocked(connector.fetch_message_delta_page).mockImplementation(delta_returning([]));
    const second = await backup_channel(
      make_scope(connector),
      CHANNEL_WITH_EMAIL,
      start(first.failed_roots),
    );

    expect(connector.get_channel_message).toHaveBeenCalledTimes(1);
    expect(second.failed_roots).toEqual({});
    expect(second.errors).toEqual([]);
    expect(second.shard.threads.m1).toEqual(thread_entry('m1'));
    expect(second.next_link).toBe('link-2');
  });

  it('reports a thread that keeps answering 400 as permanently skipped once its attempts are spent', async () => {
    const connector = make_connector({
      fetch_message_delta_page: delta_returning(['m1']),
      list_replies: vi.fn().mockRejectedValue(BAD_REQUEST),
      get_channel_message: vi.fn().mockRejectedValue(BAD_REQUEST),
    });
    let output = await backup_channel(make_scope(connector), CHANNEL_WITH_EMAIL, start());
    vi.mocked(connector.fetch_message_delta_page).mockImplementation(delta_returning([]));
    for (let run = 2; run <= MAX_FAILED_ITEM_ATTEMPTS; run++) {
      expect(output.next_link).toBe('stored-link');
      output = await backup_channel(
        make_scope(connector),
        CHANNEL_WITH_EMAIL,
        start(output.failed_roots),
      );
    }

    expect(output.failed_roots.m1).toMatchObject({ attempts: MAX_FAILED_ITEM_ATTEMPTS });
    expect(output.next_link).toBe('link-2');
    expect(describe_failed_items(output.failed_roots)).toEqual([
      expect.stringContaining(`PERMANENTLY SKIPPED after ${MAX_FAILED_ITEM_ATTEMPTS} attempts`),
    ]);
    expect(connector.get_channel_message).toHaveBeenCalledTimes(MAX_FAILED_ITEM_ATTEMPTS - 1);
  });
});
