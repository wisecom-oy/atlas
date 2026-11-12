import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamsChannelIndexEntry, TeamsSnapshotIndex } from '@wisecom/atlas-types';
import { backup_channel } from '@/services/backup/channel-backup-processor';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';
import { channel_output, make_ports, TEAM_ID } from './backup-service-harness';

vi.mock('@wisecom/atlas-core/services/shared/run-object-lock', () => ({
  lock_run_writes: vi.fn(async (ctx: unknown) => ctx),
}));
vi.mock('@/services/backup/channel-backup-processor', () => ({ backup_channel: vi.fn() }));

const DAMAGED_KEY = TEAMS_KEYS.manifest_key(TEAM_ID, 'teams-snap-2000-bbbbbb');

function older_index(): TeamsSnapshotIndex {
  const entry: TeamsChannelIndexEntry = {
    channel_id: 'channel-1',
    shard_key: 'old-shard',
    shard_checksum: 'sum',
    thread_count: 0,
    message_count: 0,
    size_bytes: 0,
  };
  return {
    team: { id: TEAM_ID, displayName: 'Team' },
    members: [],
    channels: [entry],
    created_at: new Date(1000),
  } as unknown as TeamsSnapshotIndex;
}

/**
 * Issue #694: a damaged index newer than the baseline is damaged storage, not a failed channel.
 * The run names its key for `quarantine` and keeps the error list for Graph and channel failures,
 * so the CLI can exit 9 for the one and 2 for the other.
 */
describe('TeamsBackupService with a damaged newer index (issue #694)', () => {
  beforeEach(() => {
    vi.mocked(backup_channel).mockReset();
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) =>
      channel_output(channel.id),
    );
  });

  it('names the damaged key, stays healthy, and still writes a snapshot over the older index', async () => {
    const ports = make_ports({ previous: older_index(), unreadable_keys: [DAMAGED_KEY] });

    const result = await ports.service.backup_team('tenant-1', TEAM_ID, {});

    expect(result.summary.unreadable_keys).toEqual([DAMAGED_KEY]);
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.healthy).toBe(true);
    expect(result.summary.warnings).toContain(
      'The baseline is an older snapshot because a newer one could not be read',
    );
    expect(ports.indexes.save).toHaveBeenCalledTimes(1);
  });

  it('keeps a channel failure as an error beside the damaged key', async () => {
    const ports = make_ports({ previous: older_index(), unreadable_keys: [DAMAGED_KEY] });
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      if (channel.id === 'channel-2') throw new Error('boom');
      return channel_output(channel.id);
    });

    const result = await ports.service.backup_team('tenant-1', TEAM_ID, {});

    expect(result.summary.unreadable_keys).toEqual([DAMAGED_KEY]);
    expect(result.summary.errors).toEqual(['Channel channel-2: boom']);
    expect(result.summary.healthy).toBe(false);
  });

  it('carries no unreadable_keys when every index reads', async () => {
    const ports = make_ports({ previous: older_index() });

    const result = await ports.service.backup_team('tenant-1', TEAM_ID, {});

    expect(result.summary).not.toHaveProperty('unreadable_keys');
  });
});
