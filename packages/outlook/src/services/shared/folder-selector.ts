/**
 * Shared semantics for user-supplied folder selectors (`--folder`), used by
 * backup filtering and by save/restore folder scoping so both behave alike.
 */

import { FOLDER_PATH_SEPARATOR } from '@/adapters/graph-folder-tree-enumerator';
import type { ExcludedFolder, MailboxConnector, MailFolder } from '@wisecom/atlas-types';

/**
 * True when `selector` selects `folder_path`.
 *
 * Matching is case-insensitive and accepts either a full path
 * (`Inbox/Projects`) or a bare folder name (`Projects`, matched at any depth).
 * Selecting a folder always selects everything nested beneath it, so
 * `--folder Inbox` covers `Inbox/Projects/2026`.
 */
export function folder_matches_selector(folder_path: string, selector: string): boolean {
  const wanted = selector
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .trim();
  if (!wanted) return false;

  const segments = folder_path.toLowerCase().split(FOLDER_PATH_SEPARATOR);

  // A folder matches when it -- or any ancestor -- matches, which is what makes
  // a hit on a parent pull in its whole subtree.
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === wanted) return true;
    if (segments.slice(0, i + 1).join(FOLDER_PATH_SEPARATOR) === wanted) return true;
  }

  return false;
}

/**
 * Filters mailbox folders by user selectors and reports selectors that matched nothing.
 */
export function apply_folder_filter(
  folders: MailFolder[],
  filter?: string[],
): { folders: MailFolder[]; warnings: string[] } {
  if (!filter || filter.length === 0) return { folders, warnings: [] };

  const matched = folders.filter((folder) =>
    filter.some((selector) => folder_matches_selector(folder.folder_path, selector)),
  );
  const warnings = filter
    .filter(
      (selector) =>
        !matched.some((folder) => folder_matches_selector(folder.folder_path, selector)),
    )
    .map(
      (selector) =>
        `Folder "${selector}" not found. Available: ${folders
          .map((folder) => folder.folder_path)
          .join(', ')}`,
    );

  return { folders: matched, warnings };
}

export interface ResolvedBackupFolders {
  readonly folders: MailFolder[];
  readonly warnings: string[];
  /** Folders the connector pruned, for the manifest and the run summary. */
  readonly excluded: ExcludedFolder[];
}

/**
 * Lists the folders a backup should walk: everything the connector returns,
 * narrowed by the operator's `--folder` selectors.
 *
 * Exclusions are collected here rather than inferred later, because only the
 * enumerator knows what it pruned and why, and a manifest that records the gap
 * is what makes "was folder X captured?" answerable from the backup itself.
 */
export async function resolve_backup_folders(
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  options: {
    folder_filter?: string[] | undefined;
    exclude_junk?: boolean | undefined;
    include_recoverable_items?: boolean | undefined;
  },
): Promise<ResolvedBackupFolders> {
  const excluded: ExcludedFolder[] = [];
  const all_folders = await connector.list_mail_folders(tenant_id, owner_id, {
    ...(options.exclude_junk === true ? { exclude_junk: true } : {}),
    ...(options.include_recoverable_items === true ? { include_recoverable_items: true } : {}),
    on_excluded: (folder) => excluded.push(folder),
  });

  const selection = apply_folder_filter(all_folders, options.folder_filter);
  return { folders: selection.folders, warnings: selection.warnings, excluded };
}
