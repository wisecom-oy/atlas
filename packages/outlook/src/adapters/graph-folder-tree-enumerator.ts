/**
 * Depth-first enumeration of a mailbox's mail-folder tree.
 *
 * `GET /users/{id}/mailFolders` returns only the folders directly under the
 * mailbox root -- nested folders (the default filing pattern in Outlook) are
 * reachable only through `/mailFolders/{id}/childFolders`. Enumerating the top
 * level alone silently excludes entire subtrees from backup, so every level is
 * walked here and flattened into a single list.
 *
 * @see https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders
 */

import type { MailFolder } from '@wisecom/atlas-types';
import type { GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';
import { logger } from '@wisecom/atlas-core/utils/logger';

/**
 * System folders that are never backed up. Matching prunes the whole subtree:
 * a folder nested under Junk Email is as unwanted as Junk Email itself.
 */
const EXCLUDED_FOLDERS: Record<string, true> = {
  drafts: true,
  outbox: true,
  recoverableitemsdeletions: true,
  junkemail: true,
};

/** Exchange caps folder nesting at 300 levels; deeper means a cycle, not a mailbox. */
const MAX_FOLDER_DEPTH = 300;

/** Separator between folder names in {@link MailFolder.folder_path}. */
export const FOLDER_PATH_SEPARATOR = '/';

/** Fetches one folder collection: the mailbox root when `parent_folder_id` is undefined. */
export type FolderChildrenFetcher = (parent_folder_id?: string) => Promise<GraphFolderRecord[]>;

/**
 * Walks the full folder hierarchy and returns every backed-up folder, each
 * carrying its root-relative path. Excluded subtrees are pruned, and only
 * folders reporting `childFolderCount > 0` cost an extra request.
 */
export async function enumerate_folder_tree(
  fetch_children: FolderChildrenFetcher,
): Promise<MailFolder[]> {
  return walk_folder_level(fetch_children, undefined, [], 0);
}

/** Recursively collects one folder level and the levels beneath it. */
async function walk_folder_level(
  fetch_children: FolderChildrenFetcher,
  parent_folder_id: string | undefined,
  parent_path: readonly string[],
  depth: number,
): Promise<MailFolder[]> {
  if (depth >= MAX_FOLDER_DEPTH) {
    logger.warn(
      `Mail folder nesting exceeded ${MAX_FOLDER_DEPTH} levels at ` +
        `"${parent_path.join(FOLDER_PATH_SEPARATOR)}" -- deeper folders are skipped.`,
    );
    return [];
  }

  const records = await fetch_children(parent_folder_id);
  const folders: MailFolder[] = [];

  for (const record of records) {
    if (!record.id) continue;

    const display_name = record.displayName ?? '';
    if (EXCLUDED_FOLDERS[display_name.toLowerCase()]) continue;

    const path = [...parent_path, display_name];
    folders.push({
      folder_id: record.id,
      display_name,
      folder_path: path.join(FOLDER_PATH_SEPARATOR),
      parent_folder_id: record.parentFolderId ?? undefined,
      total_item_count: record.totalItemCount ?? 0,
    });

    if ((record.childFolderCount ?? 0) > 0) {
      folders.push(...(await walk_folder_level(fetch_children, record.id, path, depth + 1)));
    }
  }

  return folders;
}
