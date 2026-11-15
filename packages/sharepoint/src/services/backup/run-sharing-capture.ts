import type {
  LatestReadableManifest,
  SharePointManifestRepository,
  SharePointSiteConnector,
  SharePointSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import { load_drive_chain_entries } from '@wisecom/atlas-drive/shared/manifest-chain';
import { create_previous_entry_lookup } from '@wisecom/atlas-drive/backup/previous-entry-lookup';
import { DriveSharingCapture } from '@wisecom/atlas-drive/backup/sharing-capture';
import { sharepoint_manifest_lookup } from '@/services/shared/manifest-lookup';

/**
 * The run's permission capture. A file whose sharing changed without a content change reuses the
 * blob of its newest earlier entry, found by folding the chain of the newest readable snapshot. The
 * chain is read only if the run meets such a file.
 */
export function create_run_sharing_capture(
  connector: SharePointSiteConnector,
  manifests: SharePointManifestRepository,
  ctx: TenantContext,
  site_id: string,
  head: LatestReadableManifest<SharePointSnapshotManifest>,
): DriveSharingCapture {
  const lookup = create_previous_entry_lookup(async () => {
    const head_snapshot_id = head.manifest?.snapshot_id;
    if (head_snapshot_id === undefined) return [];
    const chain = await load_drive_chain_entries(
      sharepoint_manifest_lookup(manifests),
      ctx,
      site_id,
      head_snapshot_id,
    );
    return chain.entries.map(({ entry }) => entry);
  });
  return new DriveSharingCapture(connector, lookup);
}
