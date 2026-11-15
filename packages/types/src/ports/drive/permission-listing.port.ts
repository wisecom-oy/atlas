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

/** Who had access to what, at one snapshot. */
export interface DrivePermissionListing {
  readonly snapshot_id: string;
  /** Items that had at least one non-inherited permission, sorted by path. */
  readonly items: readonly DriveItemPermissions[];
}
