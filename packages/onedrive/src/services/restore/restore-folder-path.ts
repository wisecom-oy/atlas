import type { OneDriveConnector } from '@wisecom/atlas-types';
import { ensure_drive_folder_path } from '@wisecom/atlas-drive/restore/folder-path';

/**
 * Resolves a restore-side path to a drive item id, creating the folders that are missing.
 *
 * `folder_ids` is the per-restore memo, keyed by `drive_id:path` so that two of the owner's
 * drives holding the same path do not resolve to one folder (issue #316).
 */
export async function ensure_onedrive_folder_path(
  connector: OneDriveConnector,
  tenant_id: string,
  owner_id: string,
  drive_id: string,
  path: string,
  folder_ids: Map<string, string>,
): Promise<string | undefined> {
  return ensure_drive_folder_path(connector, tenant_id, owner_id, drive_id, path, folder_ids);
}
