import type { Manifest } from '@/domain/outlook/manifest';
import type { OutlookSnapshotSummary } from '@/domain/shared/snapshot-summary';
import type { TenantContext, TenantStorageContext } from '@/ports/tenant/context.port';
import type {
  LatestReadableManifest,
  ReadableManifestListing,
  ReadableSnapshotSummaries,
} from '@/ports/storage/readable-listing.port';

/**
 * Outlook snapshot manifests. Reads that name one snapshot, or that need every manifest to give a
 * correct answer (`list_by_owner`, `list_all_manifests`), raise `UnreadableObjectsError` for a
 * damaged manifest. The `readable` reads skip it and name its key instead (issue #631).
 */
export interface ManifestRepository {
  save(ctx: TenantContext, manifest: Manifest): Promise<void>;

  /** @throws UnreadableContentError when the snapshot's manifest is damaged. */
  find_by_snapshot(ctx: TenantContext, snapshot_id: string): Promise<Manifest | undefined>;

  /** Returns the newest readable manifest for a mailbox owner, naming newer damaged ones. */
  find_latest_readable(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<LatestReadableManifest<Manifest>>;

  /**
   * Downloads and decrypts one mailbox owner's manifests (storage prefix `manifests/{owner_id}/`).
   *
   * @throws UnreadableObjectsError naming every damaged manifest of the owner.
   */
  list_by_owner(ctx: TenantContext, owner_id: string): Promise<Manifest[]>;

  /** Lists one owner's snapshots from its summary index, newest first, decrypting only rowless manifests. */
  list_snapshot_summaries(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<ReadableSnapshotSummaries<OutlookSnapshotSummary>>;

  /** Lists one owner's readable manifests and the keys of the damaged ones. */
  list_readable_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<ReadableManifestListing<Manifest>>;

  /**
   * Downloads and decrypts every manifest in the tenant bucket.
   *
   * @throws UnreadableObjectsError naming every damaged manifest.
   */
  list_all_manifests(ctx: TenantContext): Promise<Manifest[]>;

  /** Lists every readable manifest in the tenant and the keys of the damaged ones. */
  list_all_readable(ctx: TenantContext): Promise<ReadableManifestListing<Manifest>>;

  /** Lists every owner with at least one manifest, from key names alone (no decryption). */
  list_owner_ids(ctx: TenantStorageContext): Promise<string[]>;

  /**
   * Reads the manifest stored at exactly this key, as a listing would. Undefined when absent.
   *
   * @throws UnreadableContentError when it fails to decrypt, parse, or identify as its key.
   */
  read_manifest_at(ctx: TenantContext, storage_key: string): Promise<Manifest | undefined>;
}
