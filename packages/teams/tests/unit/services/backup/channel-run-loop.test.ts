import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FailedItemLedger,
  TeamsChannelEntry,
  TeamsGraphResource,
  TenantContext,
} from '@wisecom/atlas-types';
import { AuthError } from '@wisecom/atlas-types';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  backup_channel,
  type ChannelBackupOutput,
} from '@/services/backup/channel-backup-processor';
import { process_channels, type ChannelRunInputs } from '@/services/backup/channel-run-loop';

vi.mock('@/services/backup/channel-backup-processor', () => ({ backup_channel: vi.fn() }));

const BACKUP_AT = '2025-01-01T00:00:00.000Z';
const CHANNELS: TeamsGraphResource[] = [
  { id: 'channel-1', displayName: 'One' },
  { id: 'channel-2', displayName: 'Two' },
  { id: 'channel-3', displayName: 'Three' },
];

function channel_entry(id: string): TeamsChannelEntry {
  return { id, channel: { id }, members: [], tabs: [], read_mode: 'full', threads: {} };
}

function output(id: string, overrides: Partial<ChannelBackupOutput> = {}): ChannelBackupOutput {
  return {
    entry: channel_entry(id),
    next_link: `link-${id}`,
    complete: true,
    interrupted: false,
    failed_roots: {},
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function make_scope(should_interrupt = (): boolean => false): BackupRunScope {
  return {
    ctx: {} as TenantContext,
    connector: {} as BackupRunScope['connector'],
    tenant_id: 'tenant-1',
    team_id: 'team-1',
    backup_at: BACKUP_AT,
    counters: create_backup_counters(),
    should_interrupt,
    force_full: false,
  };
}

function inputs(overrides: Partial<ChannelRunInputs> = {}): ChannelRunInputs {
  return {
    previous_channels: undefined,
    stored_links: {},
    options: {},
    ...overrides,
  };
}

describe('process_channels', () => {
  beforeEach(() => {
    vi.mocked(backup_channel).mockReset();
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => output(channel.id));
  });

  it('rethrows an authentication failure on the first channel', async () => {
    vi.mocked(backup_channel).mockRejectedValueOnce(new AuthError('denied'));

    await expect(process_channels(make_scope(), CHANNELS, inputs(), {})).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('records an authentication failure after the first channel and keeps going', async () => {
    vi.mocked(backup_channel)
      .mockImplementationOnce(async (_scope, channel) => output(channel.id))
      .mockRejectedValueOnce(new AuthError('denied'));

    const state = await process_channels(make_scope(), CHANNELS, inputs(), {});

    expect(state.errors).toEqual(['Channel channel-2: denied']);
    expect([...state.entries.keys()]).toEqual(['channel-1', 'channel-3']);
    expect(state.attempted).toBe(3);
  });

  it('records a channel failure and still backs up the channels after it', async () => {
    vi.mocked(backup_channel).mockRejectedValueOnce(new Error('network down'));

    const state = await process_channels(make_scope(), CHANNELS, inputs(), {});

    expect(state.errors).toEqual(['Channel channel-1: network down']);
    expect([...state.entries.keys()]).toEqual(['channel-2', 'channel-3']);
  });

  it('processes only the requested channel when a channel id is given', async () => {
    const state = await process_channels(
      make_scope(),
      CHANNELS,
      inputs({ options: { channel_id: 'channel-2' } }),
      {},
    );

    expect(vi.mocked(backup_channel).mock.calls.map((call) => call[1].id)).toEqual(['channel-2']);
    expect([...state.entries.keys()]).toEqual(['channel-2']);
  });

  it('drops the stored link on a full run and keeps it otherwise', async () => {
    const stored = { 'channel-1': 'link-stored' };

    await process_channels(
      make_scope(),
      CHANNELS.slice(0, 1),
      inputs({ stored_links: stored }),
      {},
    );
    expect(vi.mocked(backup_channel).mock.calls[0]?.[3]).toBe('link-stored');

    vi.mocked(backup_channel).mockClear();
    await process_channels(
      make_scope(),
      CHANNELS.slice(0, 1),
      inputs({ stored_links: stored, options: { force_full: true } }),
      {},
    );
    expect(vi.mocked(backup_channel).mock.calls[0]?.[3]).toBeUndefined();
  });

  it('keeps the new link for a completed channel and removes the link of a channel with none', async () => {
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) =>
      channel.id === 'channel-1'
        ? output('channel-1', { next_link: undefined })
        : output(channel.id),
    );

    const state = await process_channels(
      make_scope(),
      CHANNELS.slice(0, 2),
      inputs({ stored_links: { 'channel-1': 'link-old' } }),
      {},
    );

    expect(state.links).not.toHaveProperty('channel-1');
    expect(state.links['channel-2']).toBe('link-channel-2');
  });

  it('passes a failed root from one channel to the next through the ledger', async () => {
    const failed: FailedItemLedger = {
      'root-1': {
        item_id: 'root-1',
        drive_id: 'channel-1',
        name: 'root-1',
        reason: 'boom',
        attempts: 1,
        first_failed_at: BACKUP_AT,
        last_failed_at: BACKUP_AT,
      },
    };
    vi.mocked(backup_channel).mockImplementation(
      async (_scope, channel, _previous, _link, ledger) =>
        channel.id === 'channel-1'
          ? output('channel-1', { failed_roots: failed })
          : output(channel.id, { failed_roots: ledger }),
    );

    const state = await process_channels(make_scope(), CHANNELS.slice(0, 2), inputs(), {});

    expect(vi.mocked(backup_channel).mock.calls[1]?.[4]).toEqual(failed);
    expect(state.ledger).toEqual(failed);
  });

  it('stops at an interruption and does not start the next channel', async () => {
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) =>
      output(channel.id, { interrupted: channel.id === 'channel-1' }),
    );

    const state = await process_channels(make_scope(), CHANNELS, inputs(), {});

    expect(state.interrupted).toBe(true);
    expect(backup_channel).toHaveBeenCalledTimes(1);
    expect([...state.entries.keys()]).toEqual(['channel-1']);
  });
});
