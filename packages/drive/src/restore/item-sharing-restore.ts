import type { DriveSharingConnector } from '@wisecom/atlas-types';
import { restore_parent_path } from '@wisecom/atlas-core/services/shared/restore-destination';
import type { DriveManifestEntry } from '@/drive-ports';
import { join_drive_path } from '@/shared/logical-path';
import {
  describe_permission,
  is_reapplicable_permission,
} from '@/permissions/permission-description';
import {
  count_reapplicable_permissions,
  restore_item_permissions,
} from '@/restore/permission-restore';
import type { SharingRestoreTally } from '@/restore/sharing-restore-tally';

/** What a restore needs to reapply permissions when asked. */
export interface ItemSharingRestoreDeps {
  readonly connector: DriveSharingConnector;
  /** The operator asked for permissions (`--restore-permissions`, SDK `restorePermissions`). */
  readonly restore_permissions: boolean;
  readonly tally: SharingRestoreTally;
}

/** Where a folder entry is restored. */
export interface ItemMetadataPlacement {
  readonly drive_id: string;
  /** The restore root the entry's path is placed under, as for files. */
  readonly restore_root: string;
  /** Resolves a restore-side folder path to an item id, creating what is missing. */
  readonly ensure_folder: (path: string) => Promise<string | undefined>;
}

/**
 * Reapplies a restored file's permissions, or counts them as not requested. Without the item id
 * Graph returned for the upload there is no safe item to grant on: looking the file up by path
 * could land on a different file when the upload was renamed for a conflict.
 */
export async function apply_restored_file_permissions(
  deps: ItemSharingRestoreDeps,
  drive_id: string,
  item_id: string | undefined,
  entry: DriveManifestEntry,
): Promise<void> {
  const count = count_reapplicable_permissions(entry.permissions);
  if (count === 0) return;
  if (!deps.restore_permissions) {
    deps.tally.permissions_not_requested(count);
    return;
  }
  const path = join_drive_path(entry.parent_path, entry.file_name);
  if (item_id === undefined) {
    skip_all_permissions(deps, entry, path, "Graph did not return the restored file's id");
    return;
  }
  await restore_item_permissions(
    deps.connector,
    { drive_id, item_id, path },
    entry.permissions ?? [],
    deps.tally,
  );
}

/**
 * Restores one folder entry. A folder entry exists for its metadata, so it is acted on only when
 * that metadata is requested; the folder is created then if it is missing.
 */
export async function restore_item_metadata_entry(
  deps: ItemSharingRestoreDeps,
  entry: DriveManifestEntry,
  placement: ItemMetadataPlacement,
): Promise<void> {
  const count = count_reapplicable_permissions(entry.permissions);
  if (count === 0) return;
  if (!deps.restore_permissions) {
    deps.tally.permissions_not_requested(count);
    return;
  }
  const path = join_drive_path(entry.parent_path, entry.file_name);
  const parent_path = restore_parent_path(placement.restore_root, entry.parent_path);
  const folder_id = await placement.ensure_folder(join_drive_path(parent_path, entry.file_name));
  if (folder_id === undefined) {
    skip_all_permissions(deps, entry, path, 'the folder could not be created');
    return;
  }
  await restore_item_permissions(
    deps.connector,
    { drive_id: placement.drive_id, item_id: folder_id, path },
    entry.permissions ?? [],
    deps.tally,
  );
}

function skip_all_permissions(
  deps: ItemSharingRestoreDeps,
  entry: DriveManifestEntry,
  path: string,
  reason: string,
): void {
  for (const permission of (entry.permissions ?? []).filter(is_reapplicable_permission)) {
    deps.tally.permission_skipped(path, describe_permission(permission), reason);
  }
}
