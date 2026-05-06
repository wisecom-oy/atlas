import type { OneDriveSnapshotManifest } from '../../domain/onedrive-manifest';
import type { TenantContext } from '../tenant/context.port';

export interface OneDriveManifestRepository {
  /** Persists a snapshot manifest. */
  save(ctx: TenantContext, manifest: OneDriveSnapshotManifest): Promise<void>;

  /** Finds a specific manifest by snapshot ID. */
  find_by_snapshot(
    ctx: TenantContext,
    snapshot_id: string,
  ): Promise<OneDriveSnapshotManifest | undefined>;

  /** Returns the most recent manifest for an owner. */
  find_latest_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<OneDriveSnapshotManifest | undefined>;

  /** Lists all snapshot manifests for an owner. */
  list_snapshots_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<OneDriveSnapshotManifest[]>;
}
