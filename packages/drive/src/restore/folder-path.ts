import { logger } from '@wisecom/atlas-core/utils/logger';

/** The one connector call folder creation needs. */
export interface DriveFolderCreator {
  create_folder(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    name: string,
  ): Promise<string>;
}

/**
 * Resolves a restore-side path to a drive item id, creating the folders that are missing.
 *
 * `folder_ids` is the per-restore memo, so a restore root shared by every entry is created once
 * rather than once per file. Keys are `drive_id:path`, never the path alone: one snapshot spans
 * several drives or libraries, and the same path means a different folder in each. Keying by path
 * made a restore write the second drive's files into the first drive's folder, silently, because
 * the memo answered before the create call was ever made (issue #316).
 *
 * Returns undefined when a segment could not be created; the caller reports that entry as
 * skipped, which is what keeps one over-long path from aborting the whole run.
 */
export async function ensure_drive_folder_path(
  connector: DriveFolderCreator,
  tenant_id: string,
  owner_id: string,
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
        owner_id,
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

/**
 * How many folders the restore actually created, from the memo.
 *
 * The memo also holds one root marker per drive, keyed `<drive_id>:/` with the value `root`,
 * which the run did not create. Both providers previously corrected for that with a constant,
 * which was right for exactly one drive.
 */
export function count_created_folders(folder_ids: ReadonlyMap<string, string>): number {
  let created = 0;
  for (const [key, id] of folder_ids) {
    if (id === 'root' && key.endsWith(':/')) continue;
    created++;
  }
  return created;
}
