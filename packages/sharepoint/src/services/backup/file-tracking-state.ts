import type { SharePointDeltaCursor } from '@wisecom/atlas-types';
import type { FileTrackingState } from '@/services/backup/library-item-processor';

/** Copies the per-file tracking maps out of the resumed cursor, so the run can change its own. */
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
