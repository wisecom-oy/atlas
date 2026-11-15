import type { DrivePermission } from '@wisecom/atlas-types';

/**
 * What a folder entry carries beyond the folder's identity and path. A folder's content is its
 * children, which have their own entries, so a folder gets an entry only for metadata of its own.
 * New folder metadata (such as a folder colour) joins this shape and {@link folder_needs_entry}.
 */
export interface FolderMetadata {
  readonly permissions: readonly DrivePermission[];
}

/** The one place that decides whether a folder carries metadata worth an entry. */
export function folder_needs_entry(metadata: FolderMetadata): boolean {
  return metadata.permissions.length > 0;
}

/** The metadata fields a folder entry stores, leaving out the empty ones. */
export function folder_entry_fields(metadata: FolderMetadata): {
  permissions?: readonly DrivePermission[];
} {
  return metadata.permissions.length > 0 ? { permissions: metadata.permissions } : {};
}
