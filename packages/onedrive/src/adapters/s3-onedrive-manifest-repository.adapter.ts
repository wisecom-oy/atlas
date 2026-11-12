import { injectable } from 'inversify';
import type {
  HeldOwnerLease,
  LatestReadableManifest,
  OneDriveSnapshotManifest,
  OneDriveSnapshotSummary,
  OneDriveManifestRepository,
  ReadableManifestListing,
  ReadableSnapshotSummaries,
  TenantContext,
} from '@wisecom/atlas-types';
import { forget_snapshot_summary_or_warn } from '@wisecom/atlas-core/services/shared/snapshot-summary-pruner';
import {
  find_latest_readable_by_summary,
  list_snapshot_summaries,
  list_tenant_snapshot_summaries,
} from '@wisecom/atlas-core/services/shared/snapshot-summary-reader';
import { record_snapshot_summary_or_warn } from '@wisecom/atlas-core/services/shared/snapshot-summary-writer';
import { build_drive_summary_layout } from '@wisecom/atlas-drive/shared/drive-snapshot-summary-layout';
import {
  as_manifest_listing,
  read_drive_manifest,
  read_drive_manifests,
  read_owner_drive_manifests,
  require_readable_drive_manifests,
  save_drive_manifest,
  type DriveManifestLayout,
} from '@wisecom/atlas-drive/shared/drive-manifest-store';
import {
  ONEDRIVE_KEYS,
  onedrive_manifest_key,
  onedrive_manifest_prefix,
  onedrive_manifest_root_prefix,
} from '@/services/shared/storage-keys';

const LAYOUT: DriveManifestLayout = {
  label: 'OneDrive',
  keys: ONEDRIVE_KEYS,
  owner_field: 'owner_id',
};

const SUMMARY_LAYOUT = build_drive_summary_layout<
  OneDriveSnapshotManifest,
  OneDriveSnapshotSummary
>(LAYOUT, ['owner_email', 'owner_display_name']);

/** Persists OneDrive snapshot manifests as encrypted JSON in S3. */
@injectable()
export class S3OneDriveManifestRepository implements OneDriveManifestRepository {
  /**
   * Stores a manifest through the guarded create-only write, then records it in the owner's
   * summary index, checking `lease` right before that write.
   */
  async save(
    ctx: TenantContext,
    manifest: OneDriveSnapshotManifest,
    lease?: HeldOwnerLease,
  ): Promise<void> {
    await save_drive_manifest(ctx, LAYOUT, manifest.owner_id, manifest);
    const key = onedrive_manifest_key(manifest.owner_id, manifest.snapshot_id);
    const summary = SUMMARY_LAYOUT.summarize(manifest, key);
    await record_snapshot_summary_or_warn(ctx, SUMMARY_LAYOUT, manifest.owner_id, summary, lease);
  }

  /** Drops a removed snapshot's row from the owner's summary index; logs instead of failing. */
  async forget_snapshot_summary(
    ctx: TenantContext,
    owner_id: string,
    snapshot_id: string,
  ): Promise<void> {
    await forget_snapshot_summary_or_warn(ctx, SUMMARY_LAYOUT, owner_id, snapshot_id);
  }

  /** Lists an owner's snapshots from its summary index, decrypting only rowless manifests. */
  async list_snapshot_summaries(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<ReadableSnapshotSummaries<OneDriveSnapshotSummary>> {
    return list_snapshot_summaries(ctx, SUMMARY_LAYOUT, owner_id);
  }

  /** Lists every owner's snapshots from their summary indexes. */
  async list_all_snapshot_summaries(
    ctx: TenantContext,
  ): Promise<ReadableSnapshotSummaries<OneDriveSnapshotSummary>> {
    return list_tenant_snapshot_summaries(ctx, SUMMARY_LAYOUT);
  }

  /** Loads a manifest by listing only that owner's manifest prefix; raises when it is damaged. */
  async find_by_snapshot(
    ctx: TenantContext,
    owner_id: string,
    snapshot_id: string,
  ): Promise<OneDriveSnapshotManifest | undefined> {
    const expected_key = onedrive_manifest_key(owner_id, snapshot_id);
    const keys = await ctx.storage.list(onedrive_manifest_prefix(owner_id));
    if (!keys.includes(expected_key)) return undefined;
    return read_drive_manifest<OneDriveSnapshotManifest>(ctx, LAYOUT, expected_key);
  }

  /** Returns the most recent readable manifest, chosen by the summary index, naming damaged ones. */
  async find_latest_readable(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<LatestReadableManifest<OneDriveSnapshotManifest>> {
    return find_latest_readable_by_summary(ctx, SUMMARY_LAYOUT, owner_id);
  }

  /** Lists all manifests for an owner, newest first; raises when any is damaged. */
  async list_snapshots_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<OneDriveSnapshotManifest[]> {
    return require_readable_drive_manifests(
      LAYOUT,
      await read_owner_drive_manifests<OneDriveSnapshotManifest>(ctx, LAYOUT, owner_id),
    );
  }

  /** Lists an owner's readable manifests, newest first, naming the damaged ones. */
  async list_readable_snapshots_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<ReadableManifestListing<OneDriveSnapshotManifest>> {
    return as_manifest_listing(
      await read_owner_drive_manifests<OneDriveSnapshotManifest>(ctx, LAYOUT, owner_id),
    );
  }

  /** Lists every manifest across all owners, newest first; raises when any is damaged. */
  async list_all_manifests(ctx: TenantContext): Promise<OneDriveSnapshotManifest[]> {
    const keys = await ctx.storage.list(onedrive_manifest_root_prefix());
    return require_readable_drive_manifests(
      LAYOUT,
      await read_drive_manifests<OneDriveSnapshotManifest>(ctx, LAYOUT, keys),
    );
  }

  /** Reads the manifest at exactly this key; raises when it is damaged. */
  async read_manifest_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<OneDriveSnapshotManifest | undefined> {
    return read_drive_manifest<OneDriveSnapshotManifest>(ctx, LAYOUT, storage_key);
  }
}
