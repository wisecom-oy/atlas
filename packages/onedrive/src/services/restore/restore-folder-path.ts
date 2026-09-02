// Deliberately not shared with the SharePoint copy (#306): 28 differing lines of 106. The memo
// keys differ, path here against `drive_id:path` there, which is a behavioural difference
// rather than a naming one and is tracked separately.
import type { OneDriveConnector } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

/**
 * Resolves a restore-side path to a drive item id, creating the folders that are missing.
 *
 * `folder_ids` is the per-restore memo, keyed by path, so a restore root shared by every entry is
 * created once rather than once per file. Returns undefined when a segment could not be created;
 * the caller reports that entry as skipped, which is what keeps one over-long path from aborting
 * the run. Mirrors `ensure_sharepoint_folder_path`, which keys by `drive_id:path` because a
 * SharePoint snapshot spans several libraries.
 */
export async function ensure_onedrive_folder_path(
  connector: OneDriveConnector,
  tenant_id: string,
  owner_id: string,
  drive_id: string,
  path: string,
  folder_ids: Map<string, string>,
): Promise<string | undefined> {
  const normalized = path.length === 0 || path === '.' ? '/' : path;
  const cached = folder_ids.get(normalized);
  if (cached !== undefined) return cached;

  const segments = normalized.split('/').filter(Boolean);
  let current_path = '';
  let parent_id = 'root';

  for (const segment of segments) {
    current_path = current_path ? `${current_path}/${segment}` : `/${segment}`;
    const known = folder_ids.get(current_path);
    if (known !== undefined) {
      parent_id = known;
      continue;
    }

    try {
      const folder_id = await connector.create_folder(
        tenant_id,
        owner_id,
        drive_id,
        parent_id,
        segment,
      );
      folder_ids.set(current_path, folder_id);
      parent_id = folder_id;
    } catch (err) {
      logger.warn(
        `Failed to create folder ${current_path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  return parent_id;
}
