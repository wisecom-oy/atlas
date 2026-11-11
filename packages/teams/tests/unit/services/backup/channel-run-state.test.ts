import { describe, expect, it, vi } from 'vitest';
import { UnreadableContentError, type TeamsCheckpointMode } from '@wisecom/atlas-types';
import { InMemoryTeamsChannelCheckpointRepository } from '@wisecom/atlas-types/testing/in-memory-teams-channel-checkpoint-repository';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  flush_channel_run,
  open_channel_run,
  type ChannelRunStart,
} from '@/services/backup/channel-run-state';
import {
  CHANNEL,
  make_connector,
  make_scope,
  thread_entry,
} from './channel-backup-processor-harness';

const BASELINE: ChannelRunStart = {
  baseline_shard_key: 'shard-1',
  stored_link: 'link-1',
  threads: { b: thread_entry('b') },
  failed_roots: {},
  hosted_recheck: {},
};

function scope_over(): BackupRunScope {
  return {
    ...make_scope(make_connector()),
    checkpoints: new InMemoryTeamsChannelCheckpointRepository(),
  };
}

function open(scope: BackupRunScope, start: ChannelRunStart, mode: TeamsCheckpointMode = 'delta') {
  return open_channel_run(scope, CHANNEL.id, start, mode, false);
}

describe('open_channel_run checkpoint resume', () => {
  it('resumes a matching checkpoint with every segment applied in write order', async () => {
    const scope = scope_over();
    const first = await open(scope, BASELINE);
    first.state.threads.a = thread_entry('a');
    first.next_page = 'page-2';
    await flush_channel_run(scope, first, { threads: ['a'], seen: ['a'] });
    delete first.state.threads.b;
    await flush_channel_run(scope, first, { threads: ['b'], seen: ['c'] });

    const resumed = await open(scope, BASELINE);

    expect(resumed.resumed).toBe(true);
    expect(resumed.next_page).toBe('page-2');
    expect(Object.keys(resumed.state.threads)).toEqual(['a']);
    expect([...resumed.seen].sort()).toEqual(['a', 'c']);
  });

  it.each([
    ['baseline shard', { ...BASELINE, baseline_shard_key: 'shard-2' }, 'delta'],
    ['stored link', { ...BASELINE, stored_link: 'link-2' }, 'delta'],
    ['mode', BASELINE, 'full'],
  ] as const)(
    'discards a checkpoint whose %s differs from this run',
    async (_label, start, mode) => {
      const scope = scope_over();
      const first = await open(scope, BASELINE, 'delta');
      await flush_channel_run(scope, first, { threads: [], seen: ['a'] });

      const next = await open_channel_run(scope, CHANNEL.id, start, mode, false);

      expect(next.resumed).toBe(false);
      expect(next.seen.size).toBe(0);
      expect(
        await scope.checkpoints.load_head(scope.ctx, scope.team_id, CHANNEL.id),
      ).toBeUndefined();
    },
  );

  it('resumes a full-read checkpoint left by a rejected delta link on the next delta run', async () => {
    const scope = scope_over();
    const first = await open(scope, BASELINE, 'delta');
    first.mode = 'full';
    first.next_page = 'list-page-3';
    await flush_channel_run(scope, first, { threads: [], seen: ['a'] });

    // The cursor kept the rejected link (#23), so the next run asks for a delta read again.
    const next = await open(scope, BASELINE, 'delta');

    expect(next.resumed).toBe(true);
    expect(next.mode).toBe('full');
    expect(next.next_page).toBe('list-page-3');
  });

  it("writes checkpoints through the unlocked context, not the run's locked one", async () => {
    const scope = scope_over();
    const unlocked = { ...scope.ctx };
    const locked_scope: BackupRunScope = { ...scope, checkpoint_ctx: unlocked };
    const save_head = vi.spyOn(scope.checkpoints, 'save_head');
    const save_segment = vi.spyOn(scope.checkpoints, 'save_segment');

    const run = await open(locked_scope, BASELINE);
    await flush_channel_run(locked_scope, run, { threads: [], seen: ['a'] });

    expect(save_segment.mock.calls.every(([ctx]) => ctx === unlocked)).toBe(true);
    expect(save_head.mock.calls.every(([ctx]) => ctx === unlocked)).toBe(true);
    expect(save_head).toHaveBeenCalled();
  });

  it('discards a checkpoint whose segment cannot be read and starts fresh', async () => {
    const scope = scope_over();
    const first = await open(scope, BASELINE);
    first.state.threads.a = thread_entry('a');
    await flush_channel_run(scope, first, { threads: ['a'], seen: ['a'] });
    vi.spyOn(scope.checkpoints, 'load_segment').mockRejectedValue(
      new UnreadableContentError('segment is corrupt'),
    );

    const next = await open(scope, BASELINE);

    expect(next.resumed).toBe(false);
    expect(next.state.threads).toEqual({ b: thread_entry('b') });
    expect(await scope.checkpoints.load_head(scope.ctx, scope.team_id, CHANNEL.id)).toBeUndefined();
  });

  it('still reads hosted entries an older version journaled inside segments', async () => {
    const scope = scope_over();
    const first = await open(scope, BASELINE);
    await flush_channel_run(scope, first, { threads: [], seen: ['a'] });
    const ref = { storage_key: 'blob', checksum: 'sum', size_bytes: 1, content_type: undefined };
    await scope.checkpoints.save_segment(scope.ctx, scope.team_id, CHANNEL.id, 'seg-old-0', {
      threads: {},
      seen: [],
      hosted: { 'a//h1': ref },
    });
    first.segments.push('seg-old-0');
    await flush_channel_run(scope, first, { threads: [], seen: [] });

    const next = await open(scope, BASELINE);

    expect(next.hosted.get('a//h1')).toEqual(ref);
  });

  it('resumes a done checkpoint at its retry step without discarding its stored roots', async () => {
    const scope = scope_over();
    const first = await open(scope, BASELINE);
    first.state.threads.a = thread_entry('a');
    await flush_channel_run(scope, first, { threads: ['a'], seen: ['a'] });
    first.phase = 'done';
    await flush_channel_run(scope, first, { threads: [], seen: [] });

    const next = await open_channel_run(scope, CHANNEL.id, BASELINE, 'delta', true);

    expect(next.resumed).toBe(true);
    expect(next.phase).toBe('retry');
    expect(Object.keys(next.state.threads).sort()).toEqual(['a', 'b']);
    expect([...next.seen]).toEqual(['a']);
  });
});
