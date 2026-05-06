import type { OneDriveChangeType, OneDriveDeltaItem } from '@atlas/types';

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
  const etag_missing_transition =
    (Boolean(previous_etag) && !item.etag) || (!previous_etag && Boolean(item.etag));
  const etag_changed = Boolean(previous_etag && item.etag && previous_etag !== item.etag);

  if (!previous_path && !previous_name && !previous_etag) return 'created';
  if (etag_missing_transition) return 'updated';
  if (etag_changed) return 'updated';
  if (path_changed) return 'moved';
  if (name_changed) return 'renamed';
  return undefined;
}
