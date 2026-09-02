import type { OneDriveChangeType, OneDriveDeltaItem } from '@wisecom/atlas-types';
import { classify_drive_change } from '@wisecom/atlas-drive/backup/change-classifier';

/**
 * Determines the type of change for a delta item based on previous state.
 * Returns undefined if no meaningful change is detected (skip the item).
 */
export function classify_change_type(
  item: OneDriveDeltaItem,
  previous_path_by_file_id: Record<string, string>,
  previous_name_by_file_id: Record<string, string>,
  previous_etag_by_file_id: Record<string, string>,
): OneDriveChangeType | undefined {
  return classify_drive_change(
    'OneDrive',
    item,
    previous_path_by_file_id,
    previous_name_by_file_id,
    previous_etag_by_file_id,
  );
}
