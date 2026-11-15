import type { DriveEntryKind } from '@wisecom/atlas-types';
import type { DriveChangeType, DriveDeltaItem, DriveManifestEntry } from '@/drive-ports';
import { relocation_label } from '@/backup/change-classifier';
import { build_folder_entry, build_folder_tombstone } from '@/backup/item-metadata-entries';
import { folder_needs_entry } from '@/backup/folder-metadata';
import type { DriveItemMetadataCapture } from '@/backup/item-metadata-capture';
import {
  folder_has_entry,
  forget_folder_metadata,
  observe_folder_metadata,
  record_folder_metadata,
  type FolderMetadataObservation,
  type FolderMetadataTracking,
} from '@/backup/folder-metadata-observation';

/** The cursor maps a backup run keeps per item. */
export interface DriveItemTracking extends FolderMetadataTracking {
  previous_path_by_file_id: Record<string, string>;
  previous_name_by_file_id: Record<string, string>;
  previous_etag_by_file_id: Record<string, string>;
  previous_kind_by_file_id: Record<string, DriveEntryKind>;
}

/** Remembers where a folder with an entry was, so a later move writes a new entry. */
function track_folder(tracking: DriveItemTracking, item: DriveDeltaItem): void {
  tracking.previous_path_by_file_id[item.item_id] = item.parent_path;
  tracking.previous_name_by_file_id[item.item_id] = item.file_name;
  tracking.previous_kind_by_file_id[item.item_id] = 'folder';
}

/** The item with its last known name, since Graph omits `name` on a removed item (issue #139). */
function with_known_name(item: DriveDeltaItem, tracking: DriveItemTracking): DriveDeltaItem {
  if (item.file_name) return item;
  return { ...item, file_name: tracking.previous_name_by_file_id[item.item_id] ?? '' };
}

/**
 * The entry a folder item produces, if any. A folder gets an entry only while it carries metadata
 * of its own ({@link folder_needs_entry}): non-inherited permissions, a colour, or both in one
 * entry. The cursor's permission digest and colour maps mark the folders that have one.
 *
 * - Deleted with an entry: a tombstone, so restore stops recreating it.
 * - Metadata changed, or moved while it has an entry: a new entry at the current path.
 * - Metadata gone: a superseding entry with none, so restore stops reapplying the old metadata.
 * - A failed permission read leaves the existing entry and cursor untouched.
 */
export async function process_folder_item(
  item: DriveDeltaItem,
  tracking: DriveItemTracking,
  capture: DriveItemMetadataCapture,
): Promise<DriveManifestEntry | undefined> {
  const had_entry = folder_has_entry(tracking, item.item_id);
  if (item.deleted) {
    if (!had_entry) return undefined;
    forget_folder_metadata(tracking, item.item_id);
    return build_folder_tombstone(with_known_name(item, tracking));
  }
  tracking.previous_kind_by_file_id[item.item_id] = 'folder';
  if (item.is_root === true) return undefined;

  const observation = await observe_folder_metadata(item, tracking, capture);
  if (!observation.read) return undefined;
  const relocation = had_entry ? folder_relocation(item, tracking) : undefined;
  const changed = observation.permissions_changed || observation.color_changed;
  if (!changed && relocation === undefined) return undefined;

  const metadata_change = metadata_change_type(observation);
  if (!folder_needs_entry(observation.metadata)) {
    if (!had_entry) return undefined;
    forget_folder_metadata(tracking, item.item_id);
    return build_folder_entry(item, metadata_change, observation.metadata);
  }
  record_folder_metadata(tracking, item.item_id, observation);
  track_folder(tracking, item);
  const change_type = had_entry ? (relocation ?? metadata_change) : 'created';
  return build_folder_entry(item, change_type, observation.metadata);
}

/**
 * How an existing folder entry's metadata change is labelled: `permissions_changed` when its
 * sharing changed, as for files, and `updated` when only its colour did.
 */
function metadata_change_type(
  observation: Extract<FolderMetadataObservation, { read: true }>,
): DriveChangeType {
  return observation.permissions_changed ? 'permissions_changed' : 'updated';
}

/** Whether a folder with an entry moved or was renamed since the entry was written. */
function folder_relocation(
  item: DriveDeltaItem,
  tracking: DriveItemTracking,
): DriveChangeType | undefined {
  const previous_path = tracking.previous_path_by_file_id[item.item_id];
  const previous_name = tracking.previous_name_by_file_id[item.item_id];
  return relocation_label(
    previous_path !== undefined && previous_path !== item.parent_path,
    previous_name !== undefined && previous_name !== item.file_name,
  );
}
