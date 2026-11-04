import type { TeamsSnapshotManifest } from '@/domain/teams-manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

export interface TeamsManifestRepository {
  /** Persists a snapshot manifest. */
  save(ctx: TenantContext, manifest: TeamsSnapshotManifest): Promise<void>;

  /** Finds a manifest for a team by snapshot ID. */
  find_by_snapshot(
    ctx: TenantContext,
    team_id: string,
    snapshot_id: string,
  ): Promise<TeamsSnapshotManifest | undefined>;

  /** Returns the most recent manifest for a team. */
  find_latest_by_team(
    ctx: TenantContext,
    team_id: string,
  ): Promise<TeamsSnapshotManifest | undefined>;

  /** Lists all snapshot manifests for a team. */
  list_snapshots_by_team(ctx: TenantContext, team_id: string): Promise<TeamsSnapshotManifest[]>;

  /** Lists snapshot manifests for every team in the tenant. */
  list_all_manifests(ctx: TenantContext): Promise<TeamsSnapshotManifest[]>;
}
