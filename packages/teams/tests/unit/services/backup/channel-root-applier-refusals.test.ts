import { beforeEach, describe, expect, it, vi } from 'vitest';
import { record_item_failure } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
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

const CHANGED: ChannelRootRead = { changes: [root_change('m1')], link: 'link-2', is_full: false };
const RETRY_ONLY: ChannelRootRead = { changes: [], link: 'link-2', is_full: false };

/** An HTTP error shaped as the Graph client raises it. */
function graph_status(status: number): Error {
  return Object.assign(new Error(`Graph ${status}`), { statusCode: status });
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

describe('replies refused by Graph (Q3)', () => {
  it('records a 400 on the replies of a changed root as a permanent failure', async () => {
    const connector = make_connector({
      list_replies: vi.fn(async () => {
        throw graph_status(400);
      }),
    });

    const out = await apply_root_changes(make_scope(connector), 'channel-1', CHANGED, {}, {}, {});

    expect(out.failed_roots.m1).toMatchObject({ permanent: true });
    expect(out.errors).toHaveLength(1);
  });

  it('counts a 404 on the replies of a listed root as an attempt with a warning', async () => {
    const connector = make_connector({
      list_replies: vi.fn(async () => {
        throw graph_status(404);
      }),
    });

    const out = await apply_root_changes(make_scope(connector), 'channel-1', CHANGED, {}, {}, {});

    expect(out.failed_roots.m1).toMatchObject({ attempts: 1 });
    expect(out.failed_roots.m1?.permanent).toBeFalsy();
    expect(out.errors).toEqual([]);
    expect(out.warnings).toContainEqual(expect.stringContaining('404'));
  });

  it('records a 400 on a retried root re-read as a permanent failure', async () => {
    const connector = make_connector({
      get_channel_message: vi.fn(async () => {
        throw graph_status(400);
      }),
    });
    const ledger = record_item_failure(
      {},
      { item_id: 'm1', drive_id: 'channel-1', name: 'm1', reason: 'earlier failure' },
    );

    const out = await apply_root_changes(
      make_scope(connector),
      'channel-1',
      RETRY_ONLY,
      {},
      ledger,
      {},
    );

    expect(out.failed_roots.m1).toMatchObject({ permanent: true });
    expect(out.errors).toHaveLength(1);
  });
});
