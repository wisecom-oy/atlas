import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  ConfigError,
  UnsupportedFormatVersionError,
  type FailedItemLedger,
  type TeamsChannelCursor,
  type TeamsChannelIndexEntry,
  type TeamsSnapshotIndex,
} from '@wisecom/atlas-types';
import { backup_channel } from '@/services/backup/channel-backup-processor';
import { channel_output, make_ports, TEAM_ID, TENANT_ID } from './backup-service-harness';

vi.mock('@wisecom/atlas-core/services/shared/run-object-lock', () => ({
  attach_run_retention: vi.fn(async (ctx: unknown) => ctx),
}));
vi.mock('@/services/backup/channel-backup-processor', () => ({ backup_channel: vi.fn() }));

const BACKUP_AT = '2025-01-01T00:00:00.000Z';
const FAILED_ROOT: FailedItemLedger = {
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

function index_entry(channel_id: string, shard_key: string): TeamsChannelIndexEntry {
  return {
    channel_id,
    shard_key,
    shard_checksum: 'sum',
    thread_count: 0,
    message_count: 0,
    size_bytes: 0,
  };
}

/** A previous index whose team and members match the connector stubs, so only channels differ. */
function previous_index(channels: TeamsChannelIndexEntry[]): TeamsSnapshotIndex {
  return {
    team: { id: TEAM_ID, displayName: 'Team' },
    members: [],
    channels,
    created_at: new Date(0),
  } as unknown as TeamsSnapshotIndex;
}

function cursor_for(channel_id: string, failed_roots: FailedItemLedger): TeamsChannelCursor {
  return {
    format_version: 1,
    team_id: TEAM_ID,
    channel_id,
    baseline_shard_key: `shard-${channel_id}`,
    failed_roots,
    updated_at: BACKUP_AT,
  };
}

describe('TeamsBackupService.backup_team', () => {
  beforeEach(() => {
    vi.mocked(backup_channel).mockReset();
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) =>
      channel_output(channel.id),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes an uppercase team id to lowercase for the connector, cursor and result', async () => {
    const ports = make_ports();

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID.toUpperCase(), {});

    expect(ports.connector.get_team).toHaveBeenCalledWith(TENANT_ID, TEAM_ID);
    expect(ports.cursors.save).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ team_id: TEAM_ID }),
    );
    expect(result.team_id).toBe(TEAM_ID);
  });

  it('rejects a team id that is not a GUID before calling Graph', async () => {
    const ports = make_ports();

    await expect(ports.service.backup_team(TENANT_ID, 'not-a-guid')).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect(ports.connector.get_team).not.toHaveBeenCalled();
  });

  it('throws before any write when the latest index is from a newer format (N1)', async () => {
    const ports = make_ports({ unsupported_keys: ['teams-snap-9999-cccccc'] });

    await expect(ports.service.backup_team(TENANT_ID, TEAM_ID, {})).rejects.toBeInstanceOf(
      UnsupportedFormatVersionError,
    );
    expect(ports.order).toEqual([]);
    expect(ports.shards.save).not.toHaveBeenCalled();
    expect(ports.indexes.save).not.toHaveBeenCalled();
    expect(ports.cursors.save).not.toHaveBeenCalled();
    expect(backup_channel).not.toHaveBeenCalled();
  });

  it('writes shards, then the index, then the cursors', async () => {
    const ports = make_ports();

    await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    expect(ports.order).toEqual([
      'shard:channel-1',
      'shard:channel-2',
      'index',
      'cursor:channel-1',
      'cursor:channel-2',
    ]);
  });

  it('binds each cursor to the merged shard key the index records', async () => {
    const ports = make_ports();

    await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    const index = vi.mocked(ports.indexes.save).mock.calls[0]?.[1] as TeamsSnapshotIndex;
    expect(index.channels.map((c) => c.shard_key)).toEqual(['shard-channel-1', 'shard-channel-2']);
    expect(ports.cursors.save).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channel_id: 'channel-1', baseline_shard_key: 'shard-channel-1' }),
    );
  });

  it('keeps a failed channel on its previous entry, saves no cursor for it, and goes unhealthy', async () => {
    const ports = make_ports({
      previous: previous_index([index_entry('channel-1', 'old-shard')]),
    });
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      if (channel.id === 'channel-1') throw new Error('boom');
      return channel_output(channel.id);
    });

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    const index = vi.mocked(ports.indexes.save).mock.calls[0]?.[1] as TeamsSnapshotIndex;
    expect(index.channels).toContainEqual(index_entry('channel-1', 'old-shard'));
    expect(ports.cursors.save).toHaveBeenCalledTimes(1);
    expect(ports.cursors.save).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channel_id: 'channel-2' }),
    );
    expect(result.summary.errors).toEqual(['Channel channel-1: boom']);
    expect(result.summary.healthy).toBe(false);
    expect(result.summary.no_snapshot_reason).toBeUndefined();
  });

  it('keeps a removed channel with deleted_at set to the run time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BACKUP_AT));
    const ports = make_ports({
      channels: [{ id: 'channel-1' }],
      previous: previous_index([
        index_entry('channel-1', 'shard-channel-1'),
        index_entry('channel-gone', 'old-gone'),
      ]),
    });

    await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    const index = vi.mocked(ports.indexes.save).mock.calls[0]?.[1] as TeamsSnapshotIndex;
    expect(index.channels).toContainEqual({
      ...index_entry('channel-gone', 'old-gone'),
      deleted_at: BACKUP_AT,
    });
  });

  it('reports no_content and saves only the cursors when the team has no channels', async () => {
    const ports = make_ports({ channels: [] });

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    expect(ports.indexes.save).not.toHaveBeenCalled();
    expect(result.snapshot).toBeUndefined();
    expect(result.summary).toMatchObject({
      healthy: true,
      snapshot_created: false,
      no_snapshot_reason: 'no_content',
    });
  });

  it('skips a channel owned by another tenant and reports it as a warning', async () => {
    const ports = make_ports({
      channels: [{ id: 'channel-1' }, { id: 'channel-2', tenantId: 'tenant-2' }],
    });

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    expect(backup_channel).toHaveBeenCalledTimes(1);
    expect(result.summary.warnings).toContain(
      'Channel channel-2 is owned by another tenant; skipped',
    );
  });

  it('reports a channel id that is not in the team as an error', async () => {
    const ports = make_ports();

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {
      channel_id: 'channel-9',
    });

    expect(backup_channel).not.toHaveBeenCalled();
    expect(result.summary.errors).toEqual([`Channel channel-9 is not in team ${TEAM_ID}`]);
    expect(result.summary.healthy).toBe(false);
  });

  it('stays unhealthy when a channel the run did not visit still has a failed root', async () => {
    const ports = make_ports({
      cursors: { 'channel-2': cursor_for('channel-2', FAILED_ROOT) },
    });

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {
      channel_id: 'channel-1',
    });

    expect(result.summary.healthy).toBe(false);
    expect(result.summary.no_snapshot_reason).toBeUndefined();
  });

  it('stores a failed root in the cursor and marks the run unhealthy', async () => {
    const ports = make_ports({ channels: [{ id: 'channel-1' }] });
    vi.mocked(backup_channel).mockResolvedValueOnce(
      channel_output('channel-1', { failed_roots: FAILED_ROOT }),
    );

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    expect(ports.cursors.save).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channel_id: 'channel-1', failed_roots: FAILED_ROOT }),
    );
    expect(result.summary.healthy).toBe(false);
  });

  it('keeps one ledger entry per channel when two channels fail the same root id (P12)', async () => {
    const ports = make_ports({ channels: [{ id: 'channel-1' }, { id: 'channel-2' }] });
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) =>
      channel_output(channel.id, { failed_roots: FAILED_ROOT }),
    );

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    expect(result.summary.warnings.filter((w) => w.includes('(root-1)'))).toHaveLength(2);
  });

  it('marks the run interrupted and backs up no channel when it is already interrupted', async () => {
    const ports = make_ports();

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {
      should_interrupt: () => true,
    });

    expect(backup_channel).not.toHaveBeenCalled();
    expect(result.interrupted).toBe(true);
    expect(result.summary.healthy).toBe(false);
  });

  it('rethrows an authentication failure from a channel', async () => {
    const ports = make_ports();
    vi.mocked(backup_channel).mockRejectedValueOnce(new AuthError('denied'));

    await expect(ports.service.backup_team(TENANT_ID, TEAM_ID, {})).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(ports.indexes.save).not.toHaveBeenCalled();
    expect(ports.cursors.save).not.toHaveBeenCalled();
  });
});
