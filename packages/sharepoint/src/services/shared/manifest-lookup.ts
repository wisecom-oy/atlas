import type {
  SharePointManifestRepository,
  SharePointSnapshotManifest,
} from '@wisecom/atlas-types';
import type { DriveManifestLookup } from '@wisecom/atlas-drive/shared/manifest-chain';

/** Presents the SharePoint manifest repository as the lookup pair the shared chain loader takes. */
export function sharepoint_manifest_lookup(
  manifests: SharePointManifestRepository,
): DriveManifestLookup<SharePointSnapshotManifest> {
  return {
    workload: 'SharePoint',
    find_by_snapshot: (ctx, site_id, snapshot_id) =>
      manifests.find_by_snapshot(ctx, site_id, snapshot_id),
    list_snapshots: (ctx, site_id) => manifests.list_snapshots_by_site(ctx, site_id),
  };
}
