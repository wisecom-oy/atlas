import type {
  LatestReadableManifest,
  SharePointManifestRepository,
  SharePointSiteConnector,
  SharePointSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import { load_drive_chain_entries } from '@wisecom/atlas-drive/shared/manifest-chain';
import { create_previous_entry_lookup } from '@wisecom/atlas-drive/backup/previous-entry-lookup';
import {
  create_item_metadata_capture,
  type DriveItemMetadataCapture,
} from '@wisecom/atlas-drive/backup/item-metadata-capture';
import { sharepoint_manifest_lookup } from '@/services/shared/manifest-lookup';

/**
 * The run's permission and folder colour capture. A file whose sharing changed without a content change reuses the
 * blob of its newest earlier entry, found by folding the chain of the newest readable snapshot. The
 * chain is read only if the run meets such a file.
 */
export function create_run_metadata_capture(
  connector: SharePointSiteConnector,
  manifests: SharePointManifestRepository,
  ctx: TenantContext,
  site_id: string,
  head: LatestReadableManifest<SharePointSnapshotManifest>,
): DriveItemMetadataCapture {
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
  return create_item_metadata_capture(connector, lookup);
}
