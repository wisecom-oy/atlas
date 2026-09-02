import type { OneDriveManifestRepository, OneDriveSnapshotManifest } from '@wisecom/atlas-types';
import type { DriveManifestLookup } from '@wisecom/atlas-drive/shared/manifest-chain';

/** Presents the OneDrive manifest repository as the lookup pair the shared chain loader takes. */
export function onedrive_manifest_lookup(
  manifests: OneDriveManifestRepository,
): DriveManifestLookup<OneDriveSnapshotManifest> {
  return {
    workload: 'OneDrive',
    find_by_snapshot: (ctx, owner_id, snapshot_id) =>
      manifests.find_by_snapshot(ctx, owner_id, snapshot_id),
    list_snapshots: (ctx, owner_id) => manifests.list_snapshots_by_owner(ctx, owner_id),
  };
}
