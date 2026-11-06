import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  type TeamsChannelShardRepository,
  type TeamsGraphResource,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  backup_channel,
  type ChannelBackupOutput,
} from '@/services/backup/channel-backup-processor';
import { process_channels, type ChannelRunInputs } from '@/services/backup/channel-run-loop';
import {
  BACKUP_AT,
  make_connector,
  make_scope as make_run_scope,
  previous_shard,
} from './channel-backup-processor-harness';

vi.mock('@/services/backup/channel-backup-processor', () => ({ backup_channel: vi.fn() }));

function channels(count: number): TeamsGraphResource[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `channel-${index + 1}`,
    displayName: `Channel ${index + 1}`,
  }));
}

function output(id: string, overrides: Partial<ChannelBackupOutput> = {}): ChannelBackupOutput {
  return {
    shard: { ...previous_shard({}), channel_id: id },
    reused_entry: undefined,
    next_link: `link-${id}`,
    interrupted: false,
    failed_roots: {},
    hosted_recheck: {},
    errors: [],
    warnings: [],
    resumed_from_checkpoint: false,
    checkpoint: undefined,
    ...overrides,
  };
}

function make_inputs(
  concurrency: number,
  options: ChannelRunInputs['options'] = {},
): ChannelRunInputs {
  return {
    baseline: { previous: undefined, channels: new Map(), errors: [], warnings: [] },
    shards: { load: vi.fn(), save: vi.fn() } as unknown as TeamsChannelShardRepository,
    options,
    concurrency,
  };
}

function make_scope(should_interrupt = (): boolean => false): BackupRunScope {
  return make_run_scope(make_connector(), should_interrupt);
}

/** Holds each channel open until the test releases it, so the test decides the interleaving. */
function hold_channels() {
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  return {
    started,
    hold: async (id: string): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      releases.set(id, resolve);
      started.push(id);
      await promise;
    },
    release: (id: string): void => releases.get(id)?.(),
  };
}

beforeEach(() => {
  vi.mocked(backup_channel).mockReset();
  vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => output(channel.id));
});

describe('process_channels worker pool', () => {
  it('never has more channels in flight than the concurrency allows', async () => {
    const gate = hold_channels();
    let in_flight = 0;
    let peak = 0;
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      in_flight++;
      peak = Math.max(peak, in_flight);
      await gate.hold(channel.id);
      in_flight--;
      return output(channel.id);
    });

    const run = process_channels(make_scope(), channels(6), make_inputs(2));
    await vi.waitFor(() => expect(gate.started).toEqual(['channel-1', 'channel-2']));
    gate.release('channel-1');
    await vi.waitFor(() => expect(gate.started).toContain('channel-3'));
    for (const id of ['channel-2', 'channel-3', 'channel-4', 'channel-5', 'channel-6']) {
      await vi.waitFor(() => expect(gate.started).toContain(id));
      gate.release(id);
    }
    const state = await run;

    expect(peak).toBe(2);
    expect(state.attempted).toBe(6);
    expect(state.results.size).toBe(6);
  });

  it('reports results and errors in listing order when channels finish out of order', async () => {
    const gate = hold_channels();
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      if (channel.id === 'channel-1') await gate.hold(channel.id);
      return output(channel.id, { errors: [`e-${channel.id}`] });
    });

    const run = process_channels(make_scope(), channels(3), make_inputs(2));
    await vi.waitFor(() => expect(gate.started).toEqual(['channel-1']));
    // Channel 1 is still open while 2 and 3 finish, so they complete first.
    await vi.waitFor(() => expect(vi.mocked(backup_channel)).toHaveBeenCalledTimes(3));
    gate.release('channel-1');
    const state = await run;

    expect([...state.results.keys()]).toEqual(['channel-1', 'channel-2', 'channel-3']);
    expect(state.errors).toEqual(['e-channel-1', 'e-channel-2', 'e-channel-3']);
  });

  it('stops taking new channels once interrupted, but lets started ones finish', async () => {
    const gate = hold_channels();
    let stop = false;
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      if (channel.id === 'channel-1') {
        stop = true;
        return output(channel.id);
      }
      await gate.hold(channel.id);
      return output(channel.id);
    });

    const run = process_channels(
      make_scope(() => stop),
      channels(4),
      make_inputs(2),
    );
    await vi.waitFor(() => expect(stop).toBe(true));
    gate.release('channel-2');
    const state = await run;

    expect(vi.mocked(backup_channel).mock.calls.map((call) => call[1].id)).toEqual([
      'channel-1',
      'channel-2',
    ]);
    expect(state.results.size).toBe(2);
    expect(state.interrupted).toBe(true);
  });

  it('aborts in-flight siblings on a fatal error and rethrows only after they settle', async () => {
    let sibling_settled = false;
    vi.mocked(backup_channel).mockImplementation(async (scope, channel) => {
      if (channel.id === 'channel-2') throw new AuthError('denied');
      await vi.waitFor(() => expect(scope.should_interrupt()).toBe(true));
      sibling_settled = true;
      throw new Error('aborted by pool');
    });

    const run = process_channels(make_scope(), channels(4), make_inputs(2));
    await expect(run).rejects.toBeInstanceOf(AuthError);

    expect(sibling_settled).toBe(true);
    expect(vi.mocked(backup_channel)).toHaveBeenCalledTimes(2);
  });

  it('records a finished channel as completed, incomplete, or failed and keeps going', async () => {
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      if (channel.id === 'channel-3') throw new Error('boom');
      const failed_roots =
        channel.id === 'channel-2'
          ? {
              m1: {
                item_id: 'm1',
                drive_id: 'channel-2',
                name: 'm1',
                reason: 'r',
                attempts: 1,
                first_failed_at: BACKUP_AT,
                last_failed_at: BACKUP_AT,
              },
            }
          : {};
      return output(channel.id, { failed_roots });
    });

    const state = await process_channels(make_scope(), channels(3), make_inputs(2));

    expect(state.records.get('channel-1')?.outcome).toBe('completed');
    expect(state.records.get('channel-2')?.outcome).toBe('incomplete');
    expect(state.records.get('channel-3')?.outcome).toBe('failed');
    expect(state.errors).toEqual(['Channel channel-3: boom']);
  });

  it('emits processing progress with an estimate of the time left', async () => {
    const on_progress = vi.fn();

    await process_channels(make_scope(), channels(3), make_inputs(1, { on_progress }));

    const events = on_progress.mock.calls.map((call) => call[0]);
    expect(events.filter((event) => event.phase === 'processing')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ processed: 3, total: 3, eta_ms: 0 });
  });
});
