import { injectable } from 'inversify';
import type {
  LatestReadableManifest,
  OneDriveSnapshotManifest,
  OneDriveManifestRepository,
  ReadableManifestListing,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  as_manifest_listing,
  find_latest_readable_drive_manifest,
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

/** Persists OneDrive snapshot manifests as encrypted JSON in S3. */
@injectable()
export class S3OneDriveManifestRepository implements OneDriveManifestRepository {
  /** Encrypts and uploads a manifest. */
  async save(ctx: TenantContext, manifest: OneDriveSnapshotManifest): Promise<void> {
    await save_drive_manifest(ctx, LAYOUT, manifest.owner_id, manifest);
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

  /** Returns the most recent readable manifest for an owner, naming the damaged ones. */
  async find_latest_readable(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<LatestReadableManifest<OneDriveSnapshotManifest>> {
    return find_latest_readable_drive_manifest(ctx, LAYOUT, owner_id);
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
