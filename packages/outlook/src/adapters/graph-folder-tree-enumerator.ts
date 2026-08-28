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

import type {
  FolderExclusionReason,
  MailFolder,
  MailFolderListOptions,
} from '@wisecom/atlas-types';
import type { GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';
import { logger } from '@wisecom/atlas-core/utils/logger';

/**
 * Hidden folders that hold client state rather than mail.
 *
 * Matched only when Exchange also reports the folder as hidden, so a
 * user-created folder that happens to share one of these names is still
 * backed up. Keys are lowercased display names.
 */
const HIDDEN_SYSTEM_FOLDERS: Record<string, true> = {
  'conversation action settings': true,
  'quick step settings': true,
  'working set': true,
  graphfilesandworkingsetsearchfolder: true,
  'sharepoint notifications': true,
  'social activity notifications': true,
  'yammer root': true,
  personmetadata: true,
  relevantcontacts: true,
  exchangesyncdata: true,
};

/** Display name of the Junk Email folder, which callers may opt out of. */
const JUNK_EMAIL_FOLDER = 'junk email';

/** Exchange caps folder nesting at 300 levels; deeper means a cycle, not a mailbox. */
const MAX_FOLDER_DEPTH = 300;

/** Separator between folder names in {@link MailFolder.folder_path}. */
export const FOLDER_PATH_SEPARATOR = '/';

/** Fetches one folder collection: the mailbox root when `parent_folder_id` is undefined. */
export type FolderChildrenFetcher = (parent_folder_id?: string) => Promise<GraphFolderRecord[]>;

/**
 * Walks the full folder hierarchy and returns every folder to back up, each
 * carrying its root-relative path.
 *
 * Only folders reporting `childFolderCount > 0` cost an extra request. A
 * pruned folder takes its whole subtree with it, and is reported through
 * `on_excluded` so the run can record what it did not capture.
 */
export async function enumerate_folder_tree(
  fetch_children: FolderChildrenFetcher,
  options: MailFolderListOptions = {},
): Promise<MailFolder[]> {
  return walk_folder_level(fetch_children, options, undefined, [], 0);
}

/** Recursively collects one folder level and the levels beneath it. */
async function walk_folder_level(
  fetch_children: FolderChildrenFetcher,
  options: MailFolderListOptions,
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
    const path = [...parent_path, display_name];
    const folder_path = path.join(FOLDER_PATH_SEPARATOR);

    const reason = exclusion_reason(display_name, record.isHidden === true, options);
    if (reason) {
      options.on_excluded?.({ folder_path, reason });
      continue;
    }

    folders.push({
      folder_id: record.id,
      display_name,
      folder_path,
      parent_folder_id: record.parentFolderId ?? undefined,
      total_item_count: record.totalItemCount ?? 0,
      ...(record.isHidden === true ? { is_hidden: true } : {}),
    });

    if ((record.childFolderCount ?? 0) > 0) {
      folders.push(
        ...(await walk_folder_level(fetch_children, options, record.id, path, depth + 1)),
      );
    }
  }

  return folders;
}

/**
 * Decides whether a folder is pruned, and why.
 *
 * Drafts and Outbox are deliberately absent. They were excluded by a list
 * ported from Corso's *preview* sampling mode, where a preview backup samples a
 * few containers on purpose; a full Corso backup takes them. Drafts is
 * user-authored content that exists nowhere else, so applying a preview filter
 * to every production backup was a mis-scoped port rather than a policy (issue
 * #142).
 */
function exclusion_reason(
  display_name: string,
  is_hidden: boolean,
  options: MailFolderListOptions,
): FolderExclusionReason | undefined {
  const name = display_name.toLowerCase();
  if (options.exclude_junk === true && name === JUNK_EMAIL_FOLDER) return 'junk-excluded';
  if (is_hidden && HIDDEN_SYSTEM_FOLDERS[name]) return 'hidden-system-folder';
  return undefined;
}
