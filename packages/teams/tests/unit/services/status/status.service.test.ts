import { describe, expect, it, vi } from 'vitest';
import type {
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

function setup(listings: TeamsTeamListing[]) {
  const ctx = { destroy: vi.fn() };
  const list_teams = vi.fn(async () => listings);
  const service = new TeamsStatusService(
    { create_readonly: vi.fn(async () => ctx) } as unknown as TenantContextFactory,
    { list_teams } as unknown as TeamsIndexRepository,
  );
  return { service, list_teams, ctx };
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
        unsupported_keys: [],
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
        unsupported_keys: ['teams/manifests/b/teams-snap-3000-dddddd.json'],
      },
    ]);
  });
});
