import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamsChannelIndexEntry, TeamsSnapshotIndex } from '@wisecom/atlas-types';
import { backup_channel } from '@/services/backup/channel-backup-processor';
import { channel_output, make_ports, TEAM_ID, TENANT_ID } from './backup-service-harness';

vi.mock('@wisecom/atlas-core/services/shared/run-object-lock', () => ({
  attach_run_retention: vi.fn(async (ctx: unknown) => ctx),
}));
vi.mock('@/services/backup/channel-backup-processor', () => ({ backup_channel: vi.fn() }));

const BACKUP_AT = '2025-01-01T00:00:00.000Z';
const EARLIER = '2024-06-01T00:00:00.000Z';

function index_entry(
  channel_id: string,
  overrides: Partial<TeamsChannelIndexEntry> = {},
): TeamsChannelIndexEntry {
  return {
    channel_id,
    display_name: `Name ${channel_id}`,
    shard_key: `old-${channel_id}`,
    shard_checksum: 'sum',
    thread_count: 0,
    message_count: 0,
    size_bytes: 0,
    ...overrides,
  };
}

function previous_index(channels: TeamsChannelIndexEntry[]): TeamsSnapshotIndex {
  return {
    team: { id: TEAM_ID, displayName: 'Team' },
    members: [],
    channels,
    created_at: new Date(0),
  } as unknown as TeamsSnapshotIndex;
}

function saved_index(ports: ReturnType<typeof make_ports>): TeamsSnapshotIndex {
  return vi.mocked(ports.indexes.save).mock.calls[0]?.[1] as TeamsSnapshotIndex;
}

describe('TeamsBackupService.backup_team with a channel listing that ends early', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BACKUP_AT));
    vi.mocked(backup_channel).mockReset();
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) =>
      channel_output(channel.id),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps an unlisted channel Graph still has, unchanged, and reports the run incomplete', async () => {
    const ports = make_ports({
      channels: [{ id: 'channel-1' }],
      previous: previous_index([index_entry('channel-1'), index_entry('channel-2')]),
      existing_channel_ids: ['channel-2'],
    });

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    expect(ports.connector.channel_exists).toHaveBeenCalledExactlyOnceWith(
      TENANT_ID,
      TEAM_ID,
      'channel-2',
    );
    expect(saved_index(ports).channels).toContainEqual(index_entry('channel-2'));
    expect(result.summary.errors).toEqual([
      `Channel Name channel-2 is missing from the channel listing of team ${TEAM_ID} but still ` +
        'exists; its previous backup is kept unchanged',
    ]);
    expect(result.summary.healthy).toBe(false);
  });

  it('marks an unlisted channel deleted once Graph answers 404 for it', async () => {
    const ports = make_ports({
      channels: [{ id: 'channel-1' }],
      previous: previous_index([index_entry('channel-1'), index_entry('channel-gone')]),
    });

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    expect(saved_index(ports).channels).toContainEqual(
      index_entry('channel-gone', { deleted_at: BACKUP_AT }),
    );
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.healthy).toBe(true);
  });

  it('does not read a channel by id that an earlier run already marked deleted', async () => {
    const ports = make_ports({
      channels: [{ id: 'channel-1' }],
      previous: previous_index([
        index_entry('channel-1'),
        index_entry('channel-gone', { deleted_at: EARLIER }),
      ]),
    });

    await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    expect(ports.connector.channel_exists).not.toHaveBeenCalled();
  });

  it('reads no channel by id when the listing holds every previous channel', async () => {
    const ports = make_ports({
      previous: previous_index([index_entry('channel-1'), index_entry('channel-2')]),
    });

    await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    expect(ports.connector.channel_exists).not.toHaveBeenCalled();
  });
});
