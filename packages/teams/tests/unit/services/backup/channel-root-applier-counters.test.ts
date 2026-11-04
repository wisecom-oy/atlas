import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelRootRead } from '@/services/backup/channel-root-reader';
import { apply_root_changes } from '@/services/backup/channel-root-applier';
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

const FULL: ChannelRootRead = { changes: [root_change('m1')], link: 'link-3', is_full: true };

beforeEach(() => {
  vi.mocked(store_thread).mockReset();
});

describe('thread counters (Q4)', () => {
  it('does not count an unchanged root of a full read as changed', async () => {
    vi.mocked(store_thread).mockResolvedValue({
      thread: thread_entry('m1'),
      warnings: [],
      stored: 0,
      deduped: 1,
    });
    const scope = make_scope(make_connector());

    await apply_root_changes(scope, 'channel-1', FULL, { m1: thread_entry('m1') }, {}, {});

    expect(scope.counters.threads_changed).toBe(0);
    expect(scope.counters.messages_stored).toBe(0);
    expect(scope.counters.messages_deduplicated).toBe(1);
  });

  it('counts a thread as changed and its written blobs as stored', async () => {
    vi.mocked(store_thread).mockResolvedValue({
      thread: thread_entry('m1'),
      warnings: [],
      stored: 2,
      deduped: 0,
    });
    const scope = make_scope(make_connector());

    await apply_root_changes(scope, 'channel-1', FULL, {}, {}, {});

    expect(scope.counters.threads_changed).toBe(1);
    expect(scope.counters.messages_stored).toBe(2);
  });

  it('counts a thread whose refs changed as changed even when nothing was written (S5)', async () => {
    const base = thread_entry('m1');
    vi.mocked(store_thread).mockResolvedValue({
      thread: { ...base, root: { ...base.root, last_modified_at: 'edited-later' } },
      warnings: [],
      stored: 0,
      deduped: 1,
    });
    const scope = make_scope(make_connector());

    await apply_root_changes(scope, 'channel-1', FULL, { m1: base }, {}, {});

    expect(scope.counters.threads_changed).toBe(1);
    expect(scope.counters.messages_stored).toBe(0);
  });
});
