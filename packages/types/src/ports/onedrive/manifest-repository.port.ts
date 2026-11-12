import type { OneDriveSnapshotManifest } from '../../domain/onedrive/manifest';
import type { OneDriveSnapshotSummary } from '@/domain/shared/snapshot-summary';
import type { TenantContext } from '../tenant/context.port';
import type {
  LatestReadableManifest,
  ReadableManifestListing,
  ReadableSnapshotSummaries,
} from '@/ports/storage/readable-listing.port';

/**
 * OneDrive snapshot manifests. Reads that name one snapshot, or that need every manifest to give a
 * correct answer, raise for a damaged manifest; the `readable` reads skip it and name its key
 * instead (issue #631).
 */
export interface OneDriveManifestRepository {
  /** Persists a snapshot manifest. */
  save(ctx: TenantContext, manifest: OneDriveSnapshotManifest): Promise<void>;

  /**
   * Finds a manifest for an owner by snapshot ID under that owner's prefix.
   *
   * @throws UnreadableContentError when the snapshot's manifest is damaged.
   */
  find_by_snapshot(
    ctx: TenantContext,
    owner_id: string,
    snapshot_id: string,
  ): Promise<OneDriveSnapshotManifest | undefined>;

  /** Returns the newest readable manifest for an owner, naming newer damaged ones. */
  find_latest_readable(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<LatestReadableManifest<OneDriveSnapshotManifest>>;

  /**
   * Lists all snapshot manifests for an owner, newest first.
   *
   * @throws UnreadableObjectsError naming every damaged manifest of the owner.
   */
  list_snapshots_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<OneDriveSnapshotManifest[]>;

  /** Lists an owner's readable manifests, newest first, and the keys of the damaged ones. */
  list_readable_snapshots_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<ReadableManifestListing<OneDriveSnapshotManifest>>;

  /** Lists an owner's snapshots from its summary index, newest first, decrypting only rowless manifests. */
  list_snapshot_summaries(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<ReadableSnapshotSummaries<OneDriveSnapshotSummary>>;

  /** Lists every owner's snapshots from their summary indexes, decrypting only rowless manifests. */
  list_all_snapshot_summaries(
    ctx: TenantContext,
  ): Promise<ReadableSnapshotSummaries<OneDriveSnapshotSummary>>;

  /**
   * Lists snapshot manifests for every owner in the tenant.
   *
   * @throws UnreadableObjectsError naming every damaged manifest.
   */
  list_all_manifests(ctx: TenantContext): Promise<OneDriveSnapshotManifest[]>;

  /**
   * Reads the manifest stored at exactly this key, as a listing would. Undefined when absent.
   *
   * @throws UnreadableContentError when it fails to decrypt, parse, or identify as its key.
   */
  read_manifest_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<OneDriveSnapshotManifest | undefined>;
}
