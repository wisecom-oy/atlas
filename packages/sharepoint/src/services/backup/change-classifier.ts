import type { SharePointChangeType, SharePointDeltaItem } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

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

  const path_changed = Boolean(previous_path && previous_path !== item.parent_path);
  const name_changed = Boolean(previous_name && previous_name !== item.file_name);
  // Relocation before content: an item that moved and changed in the same delta window carries
  // both signals, and the ETag branch used to answer first, erasing the move from the change
  // record (issue #297). The new content blob makes the update self-evident; the old location is
  // only recorded here. Content is downloaded either way, so the label is all that moves.
  if (path_changed || name_changed) {
    // Still worth saying when both ETags are absent: the relocation is certain, but with no ETag
    // on either side a content change alongside it cannot be detected at all.
    warn_missing_etag(item.item_id, previous_etag, item.etag);
    if (path_changed && name_changed) return 'moved_and_renamed';
    return path_changed ? 'moved' : 'renamed';
  }

  if (is_etag_transition(previous_etag, item.etag, previously_known)) {
    warn_missing_etag(item.item_id, previous_etag, item.etag);
    return 'updated';
  }
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
    `SharePoint delta item ${item_id}: missing etag on prior and current snapshot; a content change cannot be detected`,
  );
}
