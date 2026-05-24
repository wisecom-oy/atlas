import type { SharePointSnapshotManifest } from '../../domain/sharepoint-manifest';
import type { TenantContext } from '../tenant/context.port';

export interface SharePointManifestRepository {
  /** Persists a snapshot manifest. */
  save(ctx: TenantContext, manifest: SharePointSnapshotManifest): Promise<void>;

  /** Finds a manifest for a site by snapshot ID. */
  find_by_snapshot(
    ctx: TenantContext,
    site_id: string,
    snapshot_id: string,
  ): Promise<SharePointSnapshotManifest | undefined>;

  /** Returns the most recent manifest for a site. */
  find_latest_by_site(
    ctx: TenantContext,
    site_id: string,
  ): Promise<SharePointSnapshotManifest | undefined>;

  /** Lists all snapshot manifests for a site. */
  list_snapshots_by_site(
    ctx: TenantContext,
    site_id: string,
  ): Promise<SharePointSnapshotManifest[]>;
}
