import type { SharePointChangeType, SharePointDeltaItem } from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';

/**
 * Determines the type of change for a delta item based on previous state.
 * Returns undefined if no meaningful change is detected (skip the item).
 */
export function classify_change_type(
  item: SharePointDeltaItem,
  previous_path_by_file_id: Record<string, string>,
  previous_name_by_file_id: Record<string, string>,
  previous_etag_by_file_id: Record<string, string>,
): SharePointChangeType | undefined {
  if (item.deleted) return 'deleted';

  const previous_path = previous_path_by_file_id[item.item_id];
  const previous_name = previous_name_by_file_id[item.item_id];
  const previous_etag = previous_etag_by_file_id[item.item_id];
  const previously_known = Boolean(previous_path || previous_name || previous_etag);

  if (!previously_known) return 'created';
  if (is_etag_transition(previous_etag, item.etag, previously_known)) {
    warn_missing_etag(item.item_id, previous_etag, item.etag);
    return 'updated';
  }

  const path_changed = Boolean(previous_path && previous_path !== item.parent_path);
  const name_changed = Boolean(previous_name && previous_name !== item.file_name);
  if (path_changed && name_changed) return 'moved_and_renamed';
  if (path_changed) return 'moved';
  if (name_changed) return 'renamed';
  return undefined;
}

function is_etag_transition(
  previous_etag: string | undefined,
  current_etag: string | undefined,
  previously_known: boolean,
): boolean {
  if (previous_etag && !current_etag) return true;
  if (!previous_etag && current_etag) return true;
  if (previous_etag && current_etag && previous_etag !== current_etag) return true;
  return previously_known && !previous_etag && !current_etag;
}

function warn_missing_etag(
  item_id: string,
  previous_etag: string | undefined,
  current_etag: string | undefined,
): void {
  if (previous_etag || current_etag) return;
  logger.warn(
    `SharePoint delta item ${item_id}: missing etag on prior and current snapshot; classifying as updated`,
  );
}
