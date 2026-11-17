import type {
  LatestReadableManifest,
  OneDriveConnector,
  OneDriveDeltaCursor,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import { load_drive_chain_entries } from '@wisecom/atlas-drive/shared/manifest-chain';
import { create_previous_entry_lookup } from '@wisecom/atlas-drive/backup/previous-entry-lookup';
import {
  create_item_metadata_capture,
  type DriveItemMetadataCapture,
} from '@wisecom/atlas-drive/backup/item-metadata-capture';
import { onedrive_manifest_lookup } from '@/services/shared/manifest-lookup';
import type { DriveTrackingState } from '@/services/backup/delta-item-processor';

/**
 * The run's permission and folder colour capture. A file whose sharing changed without a content change reuses the
 * blob of its newest earlier entry, found by folding the chain of the newest readable snapshot. The
 * chain is read only if the run meets such a file.
 */
export function create_run_metadata_capture(
  connector: OneDriveConnector,
  manifests: OneDriveManifestRepository,
  ctx: TenantContext,
  owner_id: string,
  head: LatestReadableManifest<OneDriveSnapshotManifest>,
): DriveItemMetadataCapture {
  const lookup = create_previous_entry_lookup(async () => {
    const head_snapshot_id = head.manifest?.snapshot_id;
    if (head_snapshot_id === undefined) return [];
    const chain = await load_drive_chain_entries(
      onedrive_manifest_lookup(manifests),
      ctx,
      owner_id,
      head_snapshot_id,
    );
    return chain.entries.map(({ entry }) => entry);
  });
  return create_item_metadata_capture(connector, lookup);
}

/** Copies the per-item tracking maps out of the resumed cursor, so the run can change its own. */
export function build_tracking_state(
  previous_cursor: OneDriveDeltaCursor | undefined,
): Required<DriveTrackingState> {
  return {
    previous_path_by_file_id: { ...(previous_cursor?.previous_path_by_file_id ?? {}) },
    previous_name_by_file_id: { ...(previous_cursor?.previous_name_by_file_id ?? {}) },
    previous_etag_by_file_id: { ...(previous_cursor?.previous_etag_by_file_id ?? {}) },
    previous_kind_by_file_id: { ...(previous_cursor?.previous_kind_by_file_id ?? {}) },
    permission_digest_by_item_id: { ...(previous_cursor?.permission_digest_by_item_id ?? {}) },
    folder_color_by_item_id: { ...(previous_cursor?.folder_color_by_item_id ?? {}) },
  };
}
