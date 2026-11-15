import type { DriveDeltaItem } from '@/drive-ports';
import type { FolderMetadata } from '@/backup/folder-metadata';
import { folder_colors, type FolderColorTracking } from '@/backup/folder-color-capture';
import type { DriveItemMetadataCapture } from '@/backup/item-metadata-capture';
import {
  is_permission_candidate,
  permission_digests,
  type PermissionDigestTracking,
  type PermissionObservation,
} from '@/backup/sharing-capture';
import { digest_permissions } from '@/permissions/permission-digest';

/** The cursor maps that say which folders have an entry, and what it holds. */
export type FolderMetadataTracking = PermissionDigestTracking & FolderColorTracking;

/** What a run learned about one folder's own metadata. */
export type FolderMetadataObservation =
  | { readonly read: false }
  | {
      readonly read: true;
      readonly metadata: FolderMetadata;
      readonly permission_digest: string;
      readonly permissions_changed: boolean;
      readonly color_changed: boolean;
    };

const NOT_READ: FolderMetadataObservation = { read: false };

/**
 * A folder Graph did not mark as shared and that had no permissions last time has none now, so its
 * permissions are known without a read.
 */
const KNOWN_UNSHARED: PermissionObservation = {
  read: true,
  permissions: [],
  digest: digest_permissions([]),
  changed: false,
};

/** Whether the cursor records an entry for the folder: one holding permissions, a colour, or both. */
export function folder_has_entry(tracking: FolderMetadataTracking, item_id: string): boolean {
  return (
    tracking.permission_digest_by_item_id?.[item_id] !== undefined ||
    tracking.folder_color_by_item_id?.[item_id] !== undefined
  );
}

/**
 * What the run knows about a live folder's permissions and colour, compared with the cursor.
 *
 * - A failed permission read leaves the folder "not read": an entry written without its
 *   permissions would drop them from the snapshot.
 * - A failed colour read keeps the colour the cursor last recorded, so a permission change is still
 *   written, and the colour is compared again the next time delta returns the folder.
 */
export async function observe_folder_metadata(
  item: DriveDeltaItem,
  tracking: FolderMetadataTracking,
  capture: DriveItemMetadataCapture,
): Promise<FolderMetadataObservation> {
  const permissions = is_permission_candidate(item, tracking)
    ? await capture.sharing.observe(item, tracking)
    : KNOWN_UNSHARED;
  if (!permissions.read) return NOT_READ;
  const color = await capture.folder_colors.observe(item, tracking);
  const folder_color = color.read ? color.color : tracking.folder_color_by_item_id?.[item.item_id];
  return {
    read: true,
    metadata: { permissions: permissions.permissions, folder_color },
    permission_digest: permissions.digest,
    permissions_changed: permissions.changed,
    color_changed: color.read && color.changed,
  };
}

/** Records in the cursor what the folder's new entry holds. */
export function record_folder_metadata(
  tracking: FolderMetadataTracking,
  item_id: string,
  observation: Extract<FolderMetadataObservation, { read: true }>,
): void {
  const digests = permission_digests(tracking);
  const colors = folder_colors(tracking);
  if (observation.metadata.permissions.length > 0) digests[item_id] = observation.permission_digest;
  else delete digests[item_id];
  if (observation.metadata.folder_color !== undefined) {
    colors[item_id] = observation.metadata.folder_color;
  } else {
    delete colors[item_id];
  }
}

/** Forgets the folder's entry in the cursor, once it is tombstoned or superseded by an empty one. */
export function forget_folder_metadata(tracking: FolderMetadataTracking, item_id: string): void {
  delete permission_digests(tracking)[item_id];
  delete folder_colors(tracking)[item_id];
}
