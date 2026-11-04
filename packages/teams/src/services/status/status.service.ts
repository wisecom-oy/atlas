import { inject, injectable } from 'inversify';
import type {
  TeamsManifestRepository,
  TeamsSnapshotManifest,
  TeamsStatusUseCase,
  TeamsTeamStatus,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  TEAMS_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';

/** Maps a team's newest readable manifest to its status row. A team with none reports no backup. */
function team_status(
  team_id: string,
  manifest: TeamsSnapshotManifest | undefined,
): TeamsTeamStatus {
  if (manifest === undefined) {
    return {
      team_id,
      team_display_name: undefined,
      last_backup_at: undefined,
      last_snapshot_id: undefined,
      total_channels: 0,
    };
  }
  return {
    team_id,
    team_display_name: manifest.team_display_name,
    last_backup_at: manifest.created_at,
    last_snapshot_id: manifest.snapshot_id,
    total_channels: manifest.channels.length,
  };
}

@injectable()
export class TeamsStatusService implements TeamsStatusUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(TEAMS_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: TeamsManifestRepository,
  ) {}

  /**
   * Reports the newest readable backup run for each team in the tenant. Only one manifest per
   * team is decrypted, so the cost does not grow with the number of snapshots.
   */
  async check_teams_status(tenant_id: string): Promise<TeamsTeamStatus[]> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const latest = await this._manifests.list_latest_per_team(ctx);
      return latest.map(({ team_id, manifest }) => team_status(team_id, manifest));
    } finally {
      ctx.destroy();
    }
  }
}
