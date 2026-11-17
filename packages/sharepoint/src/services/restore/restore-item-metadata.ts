import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import type {
  SharePointManifestEntry,
  SharePointRestoreOptions,
  SharePointSiteConnector,
} from '@wisecom/atlas-types';
import {
  restore_item_metadata_entry,
  type ItemSharingRestoreDeps,
} from '@wisecom/atlas-drive/restore/item-sharing-restore';
import { ensure_sharepoint_folder_path } from '@/services/restore/restore-folder-path';
import { is_run_interrupted } from '@/services/restore/restore-result';

/** Where the folder entries of a restore go. */
export interface ItemMetadataRestoreTarget {
  readonly tenant_id: string;
  readonly target_site: string;
  readonly restore_root: string;
  readonly folder_ids: Map<string, string>;
  /** The destination library for an entry, or undefined when it cannot be placed. */
  readonly resolve_destination: (entry: SharePointManifestEntry) => string | undefined;
}

/**
 * Reapplies folder permissions after the files are in place, when asked. Every
 * outcome lands on the sharing summary; only an unexpected failure is added to `errors`.
 * Resolves true when the run was cancelled part-way.
 */
export async function restore_sharepoint_item_metadata(
  connector: SharePointSiteConnector,
  entries: readonly SharePointManifestEntry[],
  target: ItemMetadataRestoreTarget,
  sharing: ItemSharingRestoreDeps,
  options: SharePointRestoreOptions,
  errors: string[],
): Promise<boolean> {
  for (const entry of entries) {
    if (is_run_interrupted(options)) return true;
    const drive_id = target.resolve_destination(entry);
    if (drive_id === undefined) continue;
    try {
      await restore_item_metadata_entry(sharing, entry, {
        drive_id,
        restore_root: target.restore_root,
        ensure_folder: (path) =>
          ensure_sharepoint_folder_path(
            connector,
            target.tenant_id,
            target.target_site,
            drive_id,
            path,
            target.folder_ids,
          ),
      });
    } catch (err) {
      if (is_active_run_cancelled()) return true;
      errors.push(`${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return false;
}
