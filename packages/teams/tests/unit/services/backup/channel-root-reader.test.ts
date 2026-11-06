import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamsCheckpointMode, TeamsConnector, TeamsRootChange } from '@wisecom/atlas-types';
import { InMemoryTeamsChannelCheckpointRepository } from '@wisecom/atlas-types/testing/in-memory-teams-channel-checkpoint-repository';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { read_channel_pages } from '@/services/backup/channel-root-reader';
import { open_channel_run, type ChannelRunStart } from '@/services/backup/channel-run-state';
import { store_thread } from '@/services/backup/thread-store';
import {
  CHANNEL,
  TEAM_ID,
  make_connector,
  make_scope,
  root_change,
} from './channel-backup-processor-harness';

vi.mock('@/services/backup/thread-store', () => ({
  store_thread: vi.fn(),
  mark_root_removed: vi.fn(),
}));

const EMPTY_START: ChannelRunStart = {
  baseline_shard_key: undefined,
  stored_link: undefined,
  threads: {},
  failed_roots: {},
  hosted_recheck: {},
};

/** Roots m{from} up to, not including, m{to}, as one Graph listing page. */
function roots(from: number, to: number): TeamsRootChange[] {
  return Array.from({ length: to - from }, (_, i) => root_change(`m${from + i}`));
}

function applied_ids(): string[] {
  return vi.mocked(store_thread).mock.calls.map((call) => call[3].id);
}

function scope_over(connector: TeamsConnector, should_interrupt?: () => boolean): BackupRunScope {
  return {
    ...make_scope(connector, should_interrupt),
    checkpoints: new InMemoryTeamsChannelCheckpointRepository(),
  };
}

function open(
  scope: BackupRunScope,
  mode: TeamsCheckpointMode,
  has_email: boolean,
  start: ChannelRunStart = EMPTY_START,
) {
  return open_channel_run(scope, CHANNEL.id, start, mode, has_email);
}

beforeEach(() => {
  vi.mocked(store_thread).mockReset();
  vi.mocked(store_thread).mockImplementation(async (_scope, _channel, _previous, root) => ({
    thread: {
      root: {
        storage_key: root.id,
        checksum: root.id,
        size_bytes: 1,
        last_modified_at: '',
        hosted: {},
      },
      replies: {},
    },
    warnings: [],
    stored: 1,
    deduped: 0,
  }));
});

describe('read_channel_pages', () => {
  it('applies every root once across streamed listing pages', async () => {
    const connector = make_connector({
      list_channel_messages_page: vi.fn(async (_t, _team, _channel, url) => {
        if (url === undefined) return { roots: roots(0, 50), next_link: 'page-2' };
        if (url === 'page-2') return { roots: roots(50, 120) };
        throw new Error(`unexpected url ${url}`);
      }),
    });
    const scope = scope_over(connector);

    const interrupted = await read_channel_pages(scope, CHANNEL, await open(scope, 'full', false));

    expect(interrupted).toBe(false);
    expect(connector.list_channel_messages_page).toHaveBeenNthCalledWith(
      2,
      'tenant-1',
      TEAM_ID,
      CHANNEL.id,
      'page-2',
    );
    expect(applied_ids()).toHaveLength(120);
    expect(new Set(applied_ids()).size).toBe(120);
  });

  it('resumes a failed page from its saved link without re-applying earlier pages', async () => {
    const page_two_errors = [new Error('connection reset')];
    const connector = make_connector({
      list_channel_messages_page: vi.fn(async (_t, _team, _channel, url) => {
        if (url === undefined) return { roots: roots(0, 50), next_link: 'page-2' };
        if (url === 'page-2' && page_two_errors.length > 0) throw page_two_errors.shift();
        if (url === 'page-2') return { roots: roots(50, 120) };
        throw new Error(`unexpected url ${url}`);
      }),
    });
    const scope = scope_over(connector);
    await expect(
      read_channel_pages(scope, CHANNEL, await open(scope, 'full', false)),
    ).rejects.toThrow('connection reset');

    const resumed = await open(scope, 'full', false);
    expect(resumed.resumed).toBe(true);
    expect(resumed.next_page).toBe('page-2');
    await read_channel_pages(scope, CHANNEL, resumed);

    expect(applied_ids()).toHaveLength(120);
    expect(new Set(applied_ids()).size).toBe(120);
  });

  it('restarts a listing whose saved link the server rejects, skipping roots already applied', async () => {
    const page_two_errors = [
      new Error('connection reset'),
      Object.assign(new Error('gone'), { statusCode: 400 }),
    ];
    const connector = make_connector({
      list_channel_messages_page: vi.fn(async (_t, _team, _channel, url) => {
        if (url === undefined) return { roots: roots(0, 50), next_link: 'page-2' };
        if (url === 'page-2' && page_two_errors.length > 0) throw page_two_errors.shift();
        if (url === 'page-2') return { roots: roots(50, 120) };
        throw new Error(`unexpected url ${url}`);
      }),
    });
    const scope = scope_over(connector);
    await expect(
      read_channel_pages(scope, CHANNEL, await open(scope, 'full', false)),
    ).rejects.toThrow('connection reset');

    const resumed = await open(scope, 'full', false);
    await read_channel_pages(scope, CHANNEL, resumed);

    expect(vi.mocked(connector.list_channel_messages_page).mock.calls.map((c) => c[3])).toEqual([
      undefined,
      'page-2',
      'page-2',
      undefined,
      'page-2',
    ]);
    expect(applied_ids()).toHaveLength(120);
    expect(new Set(applied_ids()).size).toBe(120);
  });

  it('stops before reading any page when interrupted at the start', async () => {
    const connector = make_connector();
    const scope = scope_over(connector, () => true);

    const interrupted = await read_channel_pages(scope, CHANNEL, await open(scope, 'full', false));

    expect(interrupted).toBe(true);
    expect(connector.list_channel_messages_page).not.toHaveBeenCalled();
    expect(store_thread).not.toHaveBeenCalled();
  });

  it('falls back to a full listing when Graph rejects the stored delta link', async () => {
    const connector = make_connector({
      fetch_message_delta_page: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 400 }))
        .mockResolvedValueOnce({ roots: roots(0, 3), delta_link: 'link-2' }),
    });
    const scope = scope_over(connector);
    const run = await open(scope, 'delta', true, { ...EMPTY_START, stored_link: 'stored-link' });

    await read_channel_pages(scope, CHANNEL, run);

    expect(run.mode).toBe('full');
    expect(connector.fetch_message_delta_page).toHaveBeenNthCalledWith(
      2,
      'tenant-1',
      TEAM_ID,
      CHANNEL.id,
      undefined,
    );
    expect(connector.list_channel_messages_page).toHaveBeenCalledTimes(1);
    expect(run.phase).toBe('done');
  });
});
