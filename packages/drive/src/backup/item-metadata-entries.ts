import type { DrivePermission } from '@wisecom/atlas-types';
import type { DriveChangeType, DriveDeltaItem, DriveManifestEntry } from '@/drive-ports';
import { folder_entry_fields, type FolderMetadata } from '@/backup/folder-metadata';

/** The identity and descriptive fields every entry copies from its delta item. */
function item_fields(item: DriveDeltaItem, change_type: DriveChangeType): DriveManifestEntry {
  return {
    file_id: item.item_id,
    drive_id: item.drive_id,
    file_name: item.file_name,
    parent_path: item.parent_path,
    size_bytes: item.size_bytes,
    backup_at: new Date().toISOString(),
    change_type,
    ...(item.web_url !== undefined && { web_url: item.web_url }),
    ...(item.last_modified_at !== undefined && { last_modified_at: item.last_modified_at }),
    ...(item.etag !== undefined && { etag: item.etag }),
    ...(item.file_system_info !== undefined && { file_system_info: item.file_system_info }),
    ...(item.created_by !== undefined && { created_by: item.created_by }),
    ...(item.last_modified_by !== undefined && { last_modified_by: item.last_modified_by }),
  };
}

/** A folder's entry, carrying the folder's own metadata. */
export function build_folder_entry(
  item: DriveDeltaItem,
  change_type: DriveChangeType,
  metadata: FolderMetadata,
): DriveManifestEntry {
  return {
    ...item_fields(item, change_type),
    size_bytes: 0,
    kind: 'folder',
    ...folder_entry_fields(metadata),
  };
}

/** Retires a folder entry whose folder was deleted, so restore stops reapplying its metadata. */
export function build_folder_tombstone(item: DriveDeltaItem): DriveManifestEntry {
  return { ...item_fields(item, 'deleted'), size_bytes: 0, kind: 'folder' };
}

/**
 * The entry for a file whose sharing changed while its content did not. It reuses the blob the
 * earlier entry stored (same key, checksum and size) and takes everything else from the item as it
 * is now, so restore, save and verify read it exactly like a content entry.
 */
export function build_permissions_changed_entry(
  item: DriveDeltaItem,
  previous: DriveManifestEntry,
  permissions: readonly DrivePermission[],
): DriveManifestEntry {
  return {
    ...item_fields(item, 'permissions_changed'),
    size_bytes: previous.size_bytes,
    ...(previous.storage_key !== undefined && { storage_key: previous.storage_key }),
    ...(previous.checksum !== undefined && { checksum: previous.checksum }),
    ...(permissions.length > 0 && { permissions }),
  };
}
