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

/** Keeps the newest manifest per team. */
function latest_per_team(manifests: TeamsSnapshotManifest[]): TeamsSnapshotManifest[] {
  const latest = new Map<string, TeamsSnapshotManifest>();
  for (const manifest of manifests) {
    const current = latest.get(manifest.team_id);
    if (current === undefined || manifest.created_at.getTime() > current.created_at.getTime()) {
      latest.set(manifest.team_id, manifest);
    }
  }
  return [...latest.values()];
}

@injectable()
export class TeamsStatusService implements TeamsStatusUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(TEAMS_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: TeamsManifestRepository,
  ) {}

  /**
   * Reports the last backup run recorded for each team in the tenant, from the manifests.
   * ponytail: decrypts every manifest to find the newest per team; a per-team listing upgrades
   * this when tenants hold many snapshots.
   */
  async check_teams_status(tenant_id: string): Promise<TeamsTeamStatus[]> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const manifests = await this._manifests.list_all_manifests(ctx);
      return latest_per_team(manifests).map((manifest) => ({
        team_id: manifest.team_id,
        team_display_name: manifest.team_display_name,
        last_backup_at: manifest.created_at,
        last_snapshot_id: manifest.snapshot_id,
        total_channels: manifest.channels.length,
      }));
    } finally {
      ctx.destroy();
    }
  }
}
