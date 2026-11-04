import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  UnsupportedFormatVersionError,
  type TeamsChannelShardRepository,
  type TeamsGraphResource,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  backup_channel,
  type ChannelBackupOutput,
} from '@/services/backup/channel-backup-processor';
import { process_channels, type ChannelRunInputs } from '@/services/backup/channel-run-loop';
import type { ChannelBaseline, TeamsBaseline } from '@/services/backup/team-baseline-loader';
import {
  BACKUP_AT,
  make_connector,
  make_scope as make_run_scope,
  previous_shard,
} from './channel-backup-processor-harness';

vi.mock('@/services/backup/channel-backup-processor', () => ({ backup_channel: vi.fn() }));

const CHANNELS: TeamsGraphResource[] = [
  { id: 'channel-1', displayName: 'One' },
  { id: 'channel-2', displayName: 'Two' },
  { id: 'channel-3', displayName: 'Three' },
];

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
    ...overrides,
  };
}

function make_scope(should_interrupt = (): boolean => false): BackupRunScope {
  return make_run_scope(make_connector(), should_interrupt);
}

function make_inputs(overrides: Partial<ChannelRunInputs> = {}): ChannelRunInputs {
  const baseline: TeamsBaseline = {
    previous: undefined,
    channels: new Map(),
    errors: [],
    warnings: [],
  };
  return {
    baseline,
    shards: { load: vi.fn(), save: vi.fn() } as unknown as TeamsChannelShardRepository,
    options: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(backup_channel).mockReset();
  vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => output(channel.id));
});

describe('process_channels', () => {
  it('backs up every channel in order and collects each output', async () => {
    const state = await process_channels(make_scope(), CHANNELS, make_inputs());

    expect(vi.mocked(backup_channel).mock.calls.map((call) => call[1].id)).toEqual([
      'channel-1',
      'channel-2',
      'channel-3',
    ]);
    expect([...state.results.keys()]).toEqual(['channel-1', 'channel-2', 'channel-3']);
    expect(state.attempted).toBe(3);
    expect(state.interrupted).toBe(false);
  });

  it('processes only the channel named in options', async () => {
    const state = await process_channels(
      make_scope(),
      CHANNELS,
      make_inputs({ options: { channel_id: 'channel-2' } }),
    );

    expect(vi.mocked(backup_channel)).toHaveBeenCalledTimes(1);
    expect(state.attempted).toBe(1);
    expect([...state.results.keys()]).toEqual(['channel-2']);
  });

  it('collects the errors and warnings of each channel output', async () => {
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) =>
      output(channel.id, { errors: [`e-${channel.id}`], warnings: [`w-${channel.id}`] }),
    );

    const state = await process_channels(make_scope(), CHANNELS.slice(0, 2), make_inputs());

    expect(state.errors).toEqual(['e-channel-1', 'e-channel-2']);
    expect(state.warnings).toEqual(['w-channel-1', 'w-channel-2']);
  });

  it('starts a channel from the baseline: previous shard, stored link, and failed roots', async () => {
    const previous_entry = {
      channel_id: 'channel-1',
      shard_key: 'shard-1',
      shard_checksum: 'sum-1',
      thread_count: 0,
      message_count: 0,
      size_bytes: 0,
    };
    const shard = previous_shard({});
    const failed_roots = {
      m1: {
        item_id: 'm1',
        drive_id: 'channel-1',
        name: 'm1',
        reason: 'r',
        attempts: 1,
        first_failed_at: BACKUP_AT,
        last_failed_at: BACKUP_AT,
      },
    };
    const channels = new Map<string, ChannelBaseline>([
      [
        'channel-1',
        { previous_entry, delta_link: 'stored-link', failed_roots, hosted_recheck: { m1: 2 } },
      ],
    ]);
    const inputs = make_inputs({ baseline: { ...make_inputs().baseline, channels } });
    vi.mocked(inputs.shards.load).mockResolvedValue(shard);

    await process_channels(make_scope(), [CHANNELS[0]!], inputs);

    expect(inputs.shards.load).toHaveBeenCalledWith(expect.anything(), 'shard-1');
    expect(vi.mocked(backup_channel).mock.calls[0]?.[2]).toEqual({
      previous_entry,
      previous_shard: shard,
      stored_link: 'stored-link',
      failed_roots,
      hosted_recheck: { m1: 2 },
    });
  });

  it('stops before the first channel when the run is already interrupted', async () => {
    const state = await process_channels(
      make_scope(() => true),
      CHANNELS,
      make_inputs(),
    );

    expect(vi.mocked(backup_channel)).not.toHaveBeenCalled();
    expect(state.attempted).toBe(0);
    expect(state.interrupted).toBe(true);
  });

  it('stops after a channel whose output reports interruption', async () => {
    vi.mocked(backup_channel).mockResolvedValueOnce(output('channel-1', { interrupted: true }));

    const state = await process_channels(make_scope(), CHANNELS, make_inputs());

    expect(vi.mocked(backup_channel)).toHaveBeenCalledTimes(1);
    expect(state.interrupted).toBe(true);
  });

  it('records any other channel failure and continues with the next channel', async () => {
    vi.mocked(backup_channel)
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(async (_scope, channel) => output(channel.id));

    const state = await process_channels(make_scope(), CHANNELS.slice(0, 2), make_inputs());

    expect(state.errors).toEqual(['Channel channel-1: boom']);
    expect([...state.results.keys()]).toEqual(['channel-2']);
  });

  it('does not record a channel error when the channel fails during an interrupt (P4)', async () => {
    let stop = false;
    vi.mocked(backup_channel).mockImplementationOnce(async () => {
      stop = true;
      throw new Error('cancelled mid-request');
    });

    const state = await process_channels(
      make_scope(() => stop),
      CHANNELS.slice(0, 2),
      make_inputs(),
    );

    expect(state.errors).toEqual([]);
    expect(state.results.size).toBe(0);
    expect(state.interrupted).toBe(true);
  });

  it('rethrows an AuthError from a later channel and runs no channel after it (R6)', async () => {
    vi.mocked(backup_channel)
      .mockImplementationOnce(async (_scope, channel) => output(channel.id))
      .mockRejectedValueOnce(new AuthError('denied'));

    await expect(process_channels(make_scope(), CHANNELS, make_inputs())).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(vi.mocked(backup_channel)).toHaveBeenCalledTimes(2);
  });

  it('rethrows an UnsupportedFormatVersionError from any channel (R6)', async () => {
    vi.mocked(backup_channel).mockRejectedValueOnce(
      new UnsupportedFormatVersionError('shard written by a newer version'),
    );

    await expect(process_channels(make_scope(), CHANNELS, make_inputs())).rejects.toBeInstanceOf(
      UnsupportedFormatVersionError,
    );
    expect(vi.mocked(backup_channel)).toHaveBeenCalledTimes(1);
  });
});
