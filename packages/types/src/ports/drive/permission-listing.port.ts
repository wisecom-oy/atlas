import type { DriveFolderColor } from '@/domain/drive/item-metadata';
import type { DriveEntryKind, DrivePermission } from '@/domain/drive/permission';

/** One item's captured permissions, as the snapshot's folded chain holds them. */
export interface DriveItemPermissions {
  readonly file_id: string;
  readonly drive_id: string;
  /** Full path of the item in the snapshot. */
  readonly path: string;
  readonly kind: DriveEntryKind;
  readonly permissions: readonly DrivePermission[];
}

/** One folder's captured colour, as the snapshot's folded chain holds it. */
export interface DriveFolderColorItem {
  readonly file_id: string;
  readonly drive_id: string;
  /** Full path of the folder in the snapshot. */
  readonly path: string;
  readonly folder_color: DriveFolderColor;
}

/** Who had access to what, and how folders were coloured, at one snapshot. */
export interface DrivePermissionListing {
  readonly snapshot_id: string;
  /** Items that had at least one non-inherited permission, sorted by path. */
  readonly items: readonly DriveItemPermissions[];
  /** Folders that had a colour, sorted by path. */
  readonly folder_colors: readonly DriveFolderColorItem[];
}
