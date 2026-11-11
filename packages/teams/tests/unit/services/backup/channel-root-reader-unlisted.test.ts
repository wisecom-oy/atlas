import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamsConnector, TeamsRootFetchResult, TeamsThread } from '@wisecom/atlas-types';
import { InMemoryTeamsChannelCheckpointRepository } from '@wisecom/atlas-types/testing/in-memory-teams-channel-checkpoint-repository';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { read_channel_pages } from '@/services/backup/channel-root-reader';
import { open_channel_run, type ChannelRun } from '@/services/backup/channel-run-state';
import { mark_root_removed, store_thread } from '@/services/backup/thread-store';
import {
  BACKUP_AT,
  CHANNEL,
  make_connector,
  make_scope,
  root_change,
  thread_entry,
} from './channel-backup-processor-harness';

vi.mock('@/services/backup/thread-store', () => ({
  store_thread: vi.fn(),
  mark_root_removed: vi.fn(),
}));

/** Five live roots from an earlier run. */
const STORED: Record<string, TeamsThread> = Object.fromEntries(
  ['m0', 'm1', 'm2', 'm3', 'm4'].map((id) => [id, thread_entry(id)]),
);

/**
 * A `/messages` listing that shifted while it was paged: `m2` was the first root of page two when
 * page one was read, and a root removed in between pulled it forward onto page one, so no page holds
 * it.
 */
function shifted_listing(
  get_channel_message: TeamsConnector['get_channel_message'],
): TeamsConnector {
  return make_connector({
    list_channel_messages_page: vi.fn(async (_t, _team, _channel, url) => {
      if (url === undefined)
        return { roots: [root_change('m0'), root_change('m1')], next_link: 'p2' };
      return { roots: [root_change('m3'), root_change('m4')] };
    }),
    get_channel_message: vi.fn(get_channel_message),
  });
}

function scope_over(connector: TeamsConnector): BackupRunScope {
  return { ...make_scope(connector), checkpoints: new InMemoryTeamsChannelCheckpointRepository() };
}

async function full_read(scope: BackupRunScope): Promise<ChannelRun> {
  const run = await open_channel_run(
    scope,
    CHANNEL.id,
    {
      baseline_shard_key: 'shard-1',
      stored_link: undefined,
      threads: STORED,
      failed_roots: {},
      hosted_recheck: {},
    },
    'full',
    false,
  );
  await read_channel_pages(scope, CHANNEL, run);
  return run;
}

beforeEach(() => {
  vi.mocked(store_thread).mockReset();
  vi.mocked(store_thread).mockImplementation(async (_scope, _channel, _previous, root) => ({
    thread: thread_entry(root.id),
    warnings: [],
    stored: 0,
    deduped: 1,
  }));
  vi.mocked(mark_root_removed).mockReset();
  vi.mocked(mark_root_removed).mockImplementation((_scope, previous) => ({
    ...previous,
    deleted_at: BACKUP_AT,
  }));
});

describe('read_channel_pages, a live root the listing missed', () => {
  it('keeps a root that fell between two pages live when Graph still returns it', async () => {
    const connector = shifted_listing(async (): Promise<TeamsRootFetchResult> => ({
      status: 'found',
      change: root_change('m2'),
    }));
    const scope = scope_over(connector);

    const run = await full_read(scope);

    expect(connector.get_channel_message).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connector.get_channel_message).mock.calls[0]?.[3]).toBe('m2');
    expect(mark_root_removed).not.toHaveBeenCalled();
    expect(run.state.threads.m2?.deleted_at).toBeUndefined();
    expect(scope.counters.threads_deleted).toBe(0);
    expect(run.phase).toBe('done');
  });

  it('marks a root removed when the listing missed it and Graph answers 404', async () => {
    const connector = shifted_listing(async (): Promise<TeamsRootFetchResult> => ({
      status: 'not_found',
    }));
    const scope = scope_over(connector);

    const run = await full_read(scope);

    expect(run.state.threads.m2?.deleted_at).toBe(BACKUP_AT);
    expect(run.state.threads.m1?.deleted_at).toBeUndefined();
    expect(scope.counters.threads_deleted).toBe(1);
    expect(run.state.failed_roots).toEqual({});
  });

  it('keeps a root live and records it when its confirming read fails', async () => {
    const connector = shifted_listing(async () => {
      throw new Error('connection reset');
    });
    const scope = scope_over(connector);

    const run = await full_read(scope);

    expect(run.state.threads.m2?.deleted_at).toBeUndefined();
    expect(run.state.failed_roots.m2?.reason).toBe('connection reset');
    expect(scope.counters.threads_deleted).toBe(0);
  });

  it('reads no root by id when the listing returned every stored root', async () => {
    const connector = make_connector({
      list_channel_messages_page: vi.fn(async () => ({
        roots: Object.keys(STORED).map(root_change),
      })),
    });
    const scope = scope_over(connector);

    const run = await full_read(scope);

    expect(connector.get_channel_message).not.toHaveBeenCalled();
    expect(run.phase).toBe('done');
  });

  it('resumes an interrupted confirmation without reading the listing again', async () => {
    const connector = shifted_listing(async (): Promise<TeamsRootFetchResult> => ({
      status: 'not_found',
    }));
    const checkpoints = new InMemoryTeamsChannelCheckpointRepository();
    let confirming = false;
    const stopping: BackupRunScope = {
      ...make_scope(connector, () => confirming),
      checkpoints,
      progress: {
        roots_applied: vi.fn(() => {
          if (vi.mocked(connector.list_channel_messages_page).mock.calls.length === 2) {
            confirming = true;
          }
        }),
      },
    };
    const first = await full_read(stopping);
    expect(first.phase).toBe('retry');
    expect(connector.get_channel_message).not.toHaveBeenCalled();

    const scope: BackupRunScope = { ...make_scope(connector), checkpoints };
    const resumed = await full_read(scope);

    expect(resumed.resumed).toBe(true);
    expect(connector.list_channel_messages_page).toHaveBeenCalledTimes(2);
    expect(resumed.state.threads.m2?.deleted_at).toBe(BACKUP_AT);
  });
});
