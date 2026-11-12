import type { FailedItemLedger } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { SharePointDeltaCursor } from '@wisecom/atlas-types';
import type { FileTrackingState } from '@/services/backup/library-item-processor';

/** Copies the previous cursor's per-file tracking maps, or starts empty ones. */
export function build_tracking_state(
  previous_cursor: SharePointDeltaCursor | undefined,
): FileTrackingState {
  return {
    previous_path_by_file_id: { ...(previous_cursor?.previous_path_by_file_id ?? {}) },
    previous_name_by_file_id: { ...(previous_cursor?.previous_name_by_file_id ?? {}) },
    previous_etag_by_file_id: { ...(previous_cursor?.previous_etag_by_file_id ?? {}) },
    previous_kind_by_file_id: { ...(previous_cursor?.previous_kind_by_file_id ?? {}) },
  };
}

/** The site's delta cursor as this run leaves it. */
export function build_site_cursor(
  site_id: string,
  delta_link_by_drive: Record<string, string>,
  tracking: FileTrackingState,
  failed_items: FailedItemLedger,
  version_watermark_by_file_id: NonNullable<SharePointDeltaCursor['version_watermark_by_file_id']>,
): SharePointDeltaCursor {
  return {
    site_id,
    delta_link_by_drive,
    ...tracking,
    version_watermark_by_file_id,
    failed_items,
    updated_at: new Date().toISOString(),
  };
}
