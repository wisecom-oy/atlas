import type { SharePointSnapshotManifest } from '../../domain/sharepoint/manifest';
import type { SharePointSnapshotSummary } from '@/domain/shared/snapshot-summary';
import type { TenantContext } from '../tenant/context.port';
import type {
  LatestReadableManifest,
  ReadableManifestListing,
  ReadableSnapshotSummaries,
} from '@/ports/storage/readable-listing.port';

/**
 * SharePoint snapshot manifests. Reads that name one snapshot, or that need every manifest to give
 * a correct answer, raise for a damaged manifest; the `readable` reads skip it and name its key
 * instead (issue #631).
 */
export interface SharePointManifestRepository {
  /** Persists a snapshot manifest. */
  save(ctx: TenantContext, manifest: SharePointSnapshotManifest): Promise<void>;

  /**
   * Finds a manifest for a site by snapshot ID.
   *
   * @throws UnreadableContentError when the snapshot's manifest is damaged.
   */
  find_by_snapshot(
    ctx: TenantContext,
    site_id: string,
    snapshot_id: string,
  ): Promise<SharePointSnapshotManifest | undefined>;

  /** Returns the newest readable manifest for a site, naming newer damaged ones. */
  find_latest_readable(
    ctx: TenantContext,
    site_id: string,
  ): Promise<LatestReadableManifest<SharePointSnapshotManifest>>;

  /**
   * Lists all snapshot manifests for a site, newest first.
   *
   * @throws UnreadableObjectsError naming every damaged manifest of the site.
   */
  list_snapshots_by_site(
    ctx: TenantContext,
    site_id: string,
  ): Promise<SharePointSnapshotManifest[]>;

  /** Lists a site's readable manifests, newest first, and the keys of the damaged ones. */
  list_readable_snapshots_by_site(
    ctx: TenantContext,
    site_id: string,
  ): Promise<ReadableManifestListing<SharePointSnapshotManifest>>;

  /** Lists a site's snapshots from its summary index, newest first, decrypting only rowless manifests. */
  list_snapshot_summaries(
    ctx: TenantContext,
    site_id: string,
  ): Promise<ReadableSnapshotSummaries<SharePointSnapshotSummary>>;

  /** Lists every site's snapshots from their summary indexes, decrypting only rowless manifests. */
  list_all_snapshot_summaries(
    ctx: TenantContext,
  ): Promise<ReadableSnapshotSummaries<SharePointSnapshotSummary>>;

  /**
   * Lists snapshot manifests for every site in the tenant.
   *
   * @throws UnreadableObjectsError naming every damaged manifest.
   */
  list_all_manifests(ctx: TenantContext): Promise<SharePointSnapshotManifest[]>;

  /**
   * Reads the manifest stored at exactly this key, as a listing would. Undefined when absent.
   *
   * @throws UnreadableContentError when it fails to decrypt, parse, or identify as its key.
   */
  read_manifest_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<SharePointSnapshotManifest | undefined>;
}
