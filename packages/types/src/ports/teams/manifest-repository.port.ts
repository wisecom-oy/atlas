import type { TeamsSnapshotManifest } from '@/domain/teams-manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

/** The newest readable manifest of a team, plus newer manifests that could not be read. */
export interface TeamsLatestManifest {
  readonly manifest: TeamsSnapshotManifest | undefined;
  /** Newer manifest keys that could not be decrypted or failed the key-identity check. */
  readonly unreadable_keys: string[];
}

/** Every readable manifest of a team, plus the keys of manifests that could not be read. */
export interface TeamsSnapshotListing {
  readonly manifests: TeamsSnapshotManifest[];
  /** Manifest keys that could not be decrypted or failed the key-identity check. */
  readonly unreadable_keys: string[];
}

export interface TeamsManifestRepository {
  /** Persists a snapshot manifest. */
  save(ctx: TenantContext, manifest: TeamsSnapshotManifest): Promise<void>;

  /** Finds a manifest for a team by snapshot ID. */
  find_by_snapshot(
    ctx: TenantContext,
    team_id: string,
    snapshot_id: string,
  ): Promise<TeamsSnapshotManifest | undefined>;

  /** Returns the newest readable manifest for a team, skipping unreadable newer ones. */
  find_latest_by_team(ctx: TenantContext, team_id: string): Promise<TeamsLatestManifest>;

  /** Lists all snapshot manifests for a team. */
  list_snapshots_by_team(ctx: TenantContext, team_id: string): Promise<TeamsSnapshotListing>;

  /** Lists snapshot manifests for every team in the tenant. */
  list_all_manifests(ctx: TenantContext): Promise<TeamsSnapshotManifest[]>;

  /** Returns the newest readable manifest per team, or undefined for a team with none readable. */
  list_latest_per_team(
    ctx: TenantContext,
  ): Promise<Array<{ team_id: string; manifest: TeamsSnapshotManifest | undefined }>>;
}
