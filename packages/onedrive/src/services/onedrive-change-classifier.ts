import type { OneDriveChangeType, OneDriveDeltaItem } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

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
  if (item.deleted) return 'deleted';

  const previous_path = previous_path_by_file_id[item.item_id];
  const previous_name = previous_name_by_file_id[item.item_id];
  const previous_etag = previous_etag_by_file_id[item.item_id];
  const current_path = item.parent_path;
  const path_changed = Boolean(previous_path && previous_path !== current_path);
  const name_changed = Boolean(previous_name && previous_name !== item.file_name);
  const etag_changed = Boolean(previous_etag && item.etag && previous_etag !== item.etag);
  const etag_presence_changed = Boolean(previous_etag) !== Boolean(item.etag);
  const both_etags_missing =
    Boolean(previous_path || previous_name || previous_etag) && !previous_etag && !item.etag;
  const previously_known = Boolean(previous_path || previous_name || previous_etag);

  if (!previously_known) return 'created';
  if (etag_changed || etag_presence_changed || both_etags_missing) {
    if (both_etags_missing) {
      logger.warn(
        `OneDrive delta item ${item.item_id}: missing etag on prior and current snapshot; classifying as updated`,
      );
    }
    return 'updated';
  }
  if (path_changed && name_changed) return 'moved_and_renamed';
  if (path_changed) return 'moved';
  if (name_changed) return 'renamed';
  return undefined;
}
