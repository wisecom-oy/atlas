import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import type {
  OneDriveConnector,
  OneDriveManifestEntry,
  OperationControlOptions,
} from '@wisecom/atlas-types';
import {
  restore_item_metadata_entry,
  type ItemSharingRestoreDeps,
} from '@wisecom/atlas-drive/restore/item-sharing-restore';
import type { RoutedDrive } from '@/services/restore/drive-router';
import { ensure_onedrive_folder_path } from '@/services/restore/restore-folder-path';

/** Where the folder entries of a restore go. */
export interface ItemMetadataRestoreTarget {
  readonly tenant_id: string;
  readonly target_owner: string;
  readonly restore_root: string;
  readonly folder_ids: Map<string, string>;
  readonly resolve_target_drive: (entry: OneDriveManifestEntry) => RoutedDrive;
}

/**
 * Reapplies folder permissions after the files are in place, when asked. Every
 * outcome lands on the sharing summary; only an unexpected failure is returned as an error.
 * Resolves `interrupted` when the run was cancelled part-way.
 */
export async function restore_onedrive_item_metadata(
  connector: OneDriveConnector,
  entries: readonly OneDriveManifestEntry[],
  target: ItemMetadataRestoreTarget,
  sharing: ItemSharingRestoreDeps,
  control: OperationControlOptions,
): Promise<{ errors: string[]; interrupted: boolean }> {
  const errors: string[] = [];
  for (const entry of entries) {
    if (control.should_interrupt?.() === true || control.abort_signal?.aborted === true) {
      return { errors, interrupted: true };
    }
    const routed = target.resolve_target_drive(entry);
    // A folder whose drive is gone has no files restored under it either; they report the drive.
    if (routed.error !== undefined) continue;
    try {
      await restore_item_metadata_entry(sharing, entry, {
        drive_id: routed.drive_id,
        restore_root: target.restore_root,
        ensure_folder: (path) =>
          ensure_onedrive_folder_path(
            connector,
            target.tenant_id,
            target.target_owner,
            routed.drive_id,
            path,
            target.folder_ids,
          ),
      });
    } catch (err) {
      if (is_active_run_cancelled()) return { errors, interrupted: true };
      errors.push(`${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { errors, interrupted: false };
}
