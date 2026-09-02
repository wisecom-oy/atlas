import type { SharePointSiteConnector } from '@wisecom/atlas-types';
import { ensure_drive_folder_path } from '@wisecom/atlas-drive/restore/folder-path';

/**
 * Resolves a manifest `parent_path` to a drive item id, creating the folders that are missing.
 *
 * `folder_ids` is the per-restore memo, keyed by `drive_id:path` because one snapshot spans
 * several document libraries and the same path means a different folder in each.
 */
export async function ensure_sharepoint_folder_path(
  connector: SharePointSiteConnector,
  tenant_id: string,
  site_id: string,
  drive_id: string,
  path: string,
  folder_ids: Map<string, string>,
): Promise<string | undefined> {
  return ensure_drive_folder_path(connector, tenant_id, site_id, drive_id, path, folder_ids);
}
