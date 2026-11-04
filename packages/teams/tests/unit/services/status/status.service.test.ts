import { describe, expect, it, vi } from 'vitest';
import type {
  TeamsManifestRepository,
  TeamsSnapshotManifest,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { TeamsStatusService } from '@/services/status/status.service';

const TENANT = 'tenant-1';
const CREATED_AT = new Date('2025-01-01T00:00:00.000Z');

function manifest(snapshot_id: string, channel_count: number): TeamsSnapshotManifest {
  return {
    team_display_name: 'Finance',
    snapshot_id,
    created_at: CREATED_AT,
    channels: Array.from({ length: channel_count }, (_, index) => ({ id: `channel-${index}` })),
  } as unknown as TeamsSnapshotManifest;
}

function setup(rows: Array<{ team_id: string; manifest: TeamsSnapshotManifest | undefined }>) {
  const ctx = { destroy: vi.fn() };
  const list_latest_per_team = vi.fn(async () => rows);
  const list_all_manifests = vi.fn(async () => []);
  const service = new TeamsStatusService(
    { create_readonly: vi.fn(async () => ctx) } as unknown as TenantContextFactory,
    { list_latest_per_team, list_all_manifests } as unknown as TeamsManifestRepository,
  );
  return { service, list_latest_per_team, list_all_manifests };
}

describe('TeamsStatusService.check_teams_status', () => {
  it('reads one latest manifest per team and never decrypts every manifest (C4)', async () => {
    const { service, list_latest_per_team, list_all_manifests } = setup([
      {
        team_id: '00000000-0000-0000-0000-000000000001',
        manifest: manifest('teams-snap-2000-bbbbbb', 2),
      },
    ]);

    await service.check_teams_status(TENANT);

    expect(list_latest_per_team).toHaveBeenCalledTimes(1);
    expect(list_all_manifests).not.toHaveBeenCalled();
  });

  it('maps a team with a readable manifest to its backup fields', async () => {
    const { service } = setup([
      {
        team_id: '00000000-0000-0000-0000-000000000001',
        manifest: manifest('teams-snap-2000-bbbbbb', 2),
      },
    ]);

    expect(await service.check_teams_status(TENANT)).toEqual([
      {
        team_id: '00000000-0000-0000-0000-000000000001',
        team_display_name: 'Finance',
        last_backup_at: CREATED_AT,
        last_snapshot_id: 'teams-snap-2000-bbbbbb',
        total_channels: 2,
      },
    ]);
  });

  it('lists a team with no readable manifest with empty backup fields', async () => {
    const { service } = setup([
      { team_id: '00000000-0000-0000-0000-000000000002', manifest: undefined },
    ]);

    expect(await service.check_teams_status(TENANT)).toEqual([
      {
        team_id: '00000000-0000-0000-0000-000000000002',
        team_display_name: undefined,
        last_backup_at: undefined,
        last_snapshot_id: undefined,
        total_channels: 0,
      },
    ]);
  });
});
