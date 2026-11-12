import { injectable } from 'inversify';
import type {
  LatestReadableManifest,
  ReadableManifestListing,
  ReadableSnapshotSummaries,
  SharePointSnapshotManifest,
  SharePointSnapshotSummary,
  SharePointManifestRepository,
  TenantContext,
} from '@wisecom/atlas-types';
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
  SHAREPOINT_KEYS,
  sharepoint_manifest_key,
  sharepoint_manifest_prefix,
  sharepoint_manifest_root_prefix,
} from '@/services/shared/storage-keys';

const LAYOUT: DriveManifestLayout = {
  label: 'SharePoint',
  keys: SHAREPOINT_KEYS,
  owner_field: 'site_id',
};

const SUMMARY_LAYOUT = build_drive_summary_layout<
  SharePointSnapshotManifest,
  SharePointSnapshotSummary
>(LAYOUT, ['site_url', 'site_display_name']);

/** Persists SharePoint snapshot manifests as encrypted JSON in S3. */
@injectable()
export class S3SharePointManifestRepository implements SharePointManifestRepository {
  /** Encrypts and uploads a manifest, then records it in the site's summary index. */
  async save(ctx: TenantContext, manifest: SharePointSnapshotManifest): Promise<void> {
    await save_drive_manifest(ctx, LAYOUT, manifest.site_id, manifest);
    const key = sharepoint_manifest_key(manifest.site_id, manifest.snapshot_id);
    const summary = SUMMARY_LAYOUT.summarize(manifest, key);
    await record_snapshot_summary_or_warn(ctx, SUMMARY_LAYOUT, manifest.site_id, summary);
  }

  /** Loads a manifest by listing only that site's manifest prefix; raises when it is damaged. */
  async find_by_snapshot(
    ctx: TenantContext,
    site_id: string,
    snapshot_id: string,
  ): Promise<SharePointSnapshotManifest | undefined> {
    const expected_key = sharepoint_manifest_key(site_id, snapshot_id);
    const keys = await ctx.storage.list(sharepoint_manifest_prefix(site_id));
    if (!keys.includes(expected_key)) return undefined;
    return read_drive_manifest<SharePointSnapshotManifest>(ctx, LAYOUT, expected_key);
  }

  /** Returns the most recent readable manifest, chosen by the summary index, naming damaged ones. */
  async find_latest_readable(
    ctx: TenantContext,
    site_id: string,
  ): Promise<LatestReadableManifest<SharePointSnapshotManifest>> {
    return find_latest_readable_by_summary(ctx, SUMMARY_LAYOUT, site_id);
  }

  /** Lists a site's snapshots from its summary index, decrypting only rowless manifests. */
  async list_snapshot_summaries(
    ctx: TenantContext,
    site_id: string,
  ): Promise<ReadableSnapshotSummaries<SharePointSnapshotSummary>> {
    return list_snapshot_summaries(ctx, SUMMARY_LAYOUT, site_id);
  }

  /** Lists every site's snapshots from their summary indexes. */
  async list_all_snapshot_summaries(
    ctx: TenantContext,
  ): Promise<ReadableSnapshotSummaries<SharePointSnapshotSummary>> {
    return list_tenant_snapshot_summaries(ctx, SUMMARY_LAYOUT);
  }

  /** Lists all manifests for a site, newest first; raises when any is damaged. */
  async list_snapshots_by_site(
    ctx: TenantContext,
    site_id: string,
  ): Promise<SharePointSnapshotManifest[]> {
    return require_readable_drive_manifests(
      LAYOUT,
      await read_owner_drive_manifests<SharePointSnapshotManifest>(ctx, LAYOUT, site_id),
    );
  }

  /** Lists a site's readable manifests, newest first, naming the damaged ones. */
  async list_readable_snapshots_by_site(
    ctx: TenantContext,
    site_id: string,
  ): Promise<ReadableManifestListing<SharePointSnapshotManifest>> {
    return as_manifest_listing(
      await read_owner_drive_manifests<SharePointSnapshotManifest>(ctx, LAYOUT, site_id),
    );
  }

  /** Lists every manifest across all sites, newest first; raises when any is damaged. */
  async list_all_manifests(ctx: TenantContext): Promise<SharePointSnapshotManifest[]> {
    const keys = await ctx.storage.list(sharepoint_manifest_root_prefix());
    return require_readable_drive_manifests(
      LAYOUT,
      await read_drive_manifests<SharePointSnapshotManifest>(ctx, LAYOUT, keys),
    );
  }

  /** Reads the manifest at exactly this key; raises when it is damaged. */
  async read_manifest_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<SharePointSnapshotManifest | undefined> {
    return read_drive_manifest<SharePointSnapshotManifest>(ctx, LAYOUT, storage_key);
  }
}
