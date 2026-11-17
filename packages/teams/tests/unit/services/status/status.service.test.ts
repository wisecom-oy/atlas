import { describe, expect, it, vi } from 'vitest';
import type {
  TeamsChannelCursor,
  TeamsChannelCursorRepository,
  TeamsCursorScan,
  TeamsIndexRepository,
  TeamsSnapshotIndex,
  TeamsTeamListing,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { TeamsStatusService } from '@/services/status/status.service';

const TEAM_A = '00000000-0000-0000-0000-000000000001';
const TEAM_B = '00000000-0000-0000-0000-000000000002';

function index(snapshot_id: string, channel_count: number): TeamsSnapshotIndex {
  return {
    id: `${TEAM_A}-${snapshot_id}`,
    format_version: 1,
    tenant_id: 'tenant',
    team_id: TEAM_A,
    team_display_name: 'Finance',
    snapshot_id,
    created_at: new Date('2025-01-01T00:00:00.000Z'),
    team: { id: TEAM_A },
    members: [],
    channels: Array.from({ length: channel_count }, (_, n) => ({
      channel_id: `channel-${n}`,
      shard_key: `key-${n}`,
      shard_checksum: 'unused',
      thread_count: 0,
      message_count: 0,
      size_bytes: 0,
    })),
    totals: { thread_count: 0, message_count: 0, size_bytes: 0 },
  };
}

const EMPTY_SCAN: TeamsCursorScan = { cursors: [], unreadable_keys: [], unsupported_keys: [] };

function setup(listings: TeamsTeamListing[], scans: Record<string, TeamsCursorScan> = {}) {
  const ctx = { destroy: vi.fn() };
  const list_teams = vi.fn(async () => listings);
  const scan = vi.fn(async (_ctx: unknown, team_id: string) => scans[team_id] ?? EMPTY_SCAN);
  const service = new TeamsStatusService(
    { create_readonly: vi.fn(async () => ctx) } as unknown as TenantContextFactory,
    { list_teams } as unknown as TeamsIndexRepository,
    { scan } as unknown as TeamsChannelCursorRepository,
  );
  return { service, list_teams, ctx, scan };
}

function cursor_with_failed_roots(channel_id: string, root_ids: string[]): TeamsChannelCursor {
  const failed_roots = Object.fromEntries(
    root_ids.map((root_id) => [
      root_id,
      {
        item_id: root_id,
        drive_id: channel_id,
        name: root_id,
        reason: 'graph 500',
        attempts: 1,
        first_failed_at: '2025-01-01T00:00:00.000Z',
        last_failed_at: '2025-01-01T00:00:00.000Z',
      },
    ]),
  );
  return {
    format_version: 1,
    team_id: TEAM_A,
    channel_id,
    baseline_shard_key: `teams/shards/${TEAM_A}/${channel_id}/name.json`,
    failed_roots,
    updated_at: '2025-01-01T00:00:00.000Z',
  } as TeamsChannelCursor;
}

describe('TeamsStatusService.check_teams_status', () => {
  it('reports the newest readable index of each team with the keys it skipped', async () => {
    const newest = index('teams-snap-2000-bbbbbb', 2);
    const { service, list_teams } = setup([
      {
        team_id: TEAM_A,
        listing: {
          indexes: [newest, index('teams-snap-1000-aaaaaa', 5)],
          unreadable_keys: ['teams/manifests/a/teams-snap-500-cccccc.json'],
          unsupported_keys: [],
        },
      },
    ]);

    const rows = await service.check_teams_status('tenant');

    expect(rows).toEqual([
      {
        team_id: TEAM_A,
        team_display_name: 'Finance',
        last_backup_at: newest.created_at,
        last_snapshot_id: 'teams-snap-2000-bbbbbb',
        total_channels: 2,
        unreadable_keys: ['teams/manifests/a/teams-snap-500-cccccc.json'],
        unreadable_index_keys: ['teams/manifests/a/teams-snap-500-cccccc.json'],
        unsupported_keys: [],
        failed_root_count: 0,
        pending_recheck_count: 0,
      },
    ]);
    expect(list_teams).toHaveBeenCalledTimes(1);
  });

  it('still lists a team whose only indexes are newer-format, with no backup and the key reported', async () => {
    const { service } = setup([
      {
        team_id: TEAM_B,
        listing: {
          indexes: [],
          unreadable_keys: [],
          unsupported_keys: ['teams/manifests/b/teams-snap-3000-dddddd.json'],
        },
      },
    ]);

    const rows = await service.check_teams_status('tenant');

    expect(rows).toEqual([
      {
        team_id: TEAM_B,
        team_display_name: undefined,
        last_backup_at: undefined,
        last_snapshot_id: undefined,
        total_channels: 0,
        unreadable_keys: [],
        unreadable_index_keys: [],
        unsupported_keys: ['teams/manifests/b/teams-snap-3000-dddddd.json'],
        failed_root_count: 0,
        pending_recheck_count: 0,
      },
    ]);
  });

  it('adds damaged cursor keys to unreadable_keys but not to the index keys, and counts failed roots (P9, #694)', async () => {
    const damaged_cursor = 'teams/_meta/a/channels/channel-9.json';
    const damaged_index = 'teams/manifests/a/teams-snap-500-cccccc.json';
    const newer_cursor = 'teams/_meta/a/channels/channel-8.json';
    const { service } = setup(
      [
        {
          team_id: TEAM_A,
          listing: {
            indexes: [index('teams-snap-2000-bbbbbb', 1)],
            unreadable_keys: [damaged_index],
            unsupported_keys: [],
          },
        },
      ],
      {
        [TEAM_A]: {
          cursors: [
            cursor_with_failed_roots('channel-1', ['root-1', 'root-2']),
            cursor_with_failed_roots('channel-2', ['root-3']),
          ],
          unreadable_keys: [damaged_cursor],
          unsupported_keys: [newer_cursor],
        },
      },
    );

    const [row] = await service.check_teams_status('tenant');

    // unreadable_keys keeps its shape from before #694; only indexes can be quarantined.
    expect(row?.unreadable_keys).toEqual([damaged_index, damaged_cursor]);
    expect(row?.unreadable_index_keys).toEqual([damaged_index]);
    expect(row?.unsupported_keys).toEqual([newer_cursor]);
    expect(row?.failed_root_count).toBe(3);
  });

  it('counts hosted rechecks still pending per team (P9)', async () => {
    const cursor = {
      ...cursor_with_failed_roots('channel-1', []),
      hosted_recheck: { 'root-1': 1, 'root-2': 2 },
    } as TeamsChannelCursor;
    const { service } = setup(
      [
        {
          team_id: TEAM_A,
          listing: {
            indexes: [index('teams-snap-2000-bbbbbb', 1)],
            unreadable_keys: [],
            unsupported_keys: [],
          },
        },
      ],
      { [TEAM_A]: { cursors: [cursor], unreadable_keys: [], unsupported_keys: [] } },
    );

    const [row] = await service.check_teams_status('tenant');

    expect(row?.pending_recheck_count).toBe(2);
    expect(row?.failed_root_count).toBe(0);
  });

  it('does not count a hosted recheck that reached the attempt cap as pending (S3)', async () => {
    const cursor = {
      ...cursor_with_failed_roots('channel-1', []),
      hosted_recheck: { 'root-1': 1, 'root-2': 5 },
    } as TeamsChannelCursor;
    const { service } = setup(
      [
        {
          team_id: TEAM_A,
          listing: {
            indexes: [index('teams-snap-2000-bbbbbb', 1)],
            unreadable_keys: [],
            unsupported_keys: [],
          },
        },
      ],
      { [TEAM_A]: { cursors: [cursor], unreadable_keys: [], unsupported_keys: [] } },
    );

    const [row] = await service.check_teams_status('tenant');

    expect(row?.pending_recheck_count).toBe(1);
  });
});
