// Deliberately not shared with the OneDrive copy (#306): 28 differing lines of 106. The memo
// keys differ, `drive_id:path` here against path alone there, which is a behavioural
// difference rather than a naming one and is tracked separately.
import type { SharePointSiteConnector } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

/**
 * Resolves a manifest `parent_path` to a drive item id, creating the folders that are missing.
 *
 * `folder_ids` is the per-restore memo. Keys are `drive_id:path` because one snapshot spans several
 * document libraries and the same path means a different folder in each. Returns undefined when a
 * segment could not be created; the caller reports the entry as skipped.
 */
export async function ensure_sharepoint_folder_path(
  connector: SharePointSiteConnector,
  tenant_id: string,
  site_id: string,
  drive_id: string,
  path: string,
  folder_ids: Map<string, string>,
): Promise<string | undefined> {
  const normalized = path.length === 0 || path === '.' ? '/' : path;
  const cache_key = `${drive_id}:${normalized}`;
  const cached = folder_ids.get(cache_key);
  if (cached !== undefined) return cached;

  if (normalized === '/') {
    folder_ids.set(cache_key, 'root');
    return 'root';
  }

  const segments = normalized.split('/').filter(Boolean);
  let current_path = '';
  let parent_id = 'root';

  for (const segment of segments) {
    current_path = current_path ? `${current_path}/${segment}` : `/${segment}`;
    const segment_key = `${drive_id}:${current_path}`;
    const known = folder_ids.get(segment_key);
    if (known !== undefined) {
      parent_id = known;
      continue;
    }

    try {
      const folder_id = await connector.create_folder(
        tenant_id,
        site_id,
        drive_id,
        parent_id,
        segment,
      );
      folder_ids.set(segment_key, folder_id);
      parent_id = folder_id;
    } catch (err) {
      logger.warn(
        `Failed to create folder ${current_path} in drive ${drive_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  return parent_id;
}
