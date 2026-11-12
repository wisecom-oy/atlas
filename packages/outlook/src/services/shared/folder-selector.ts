/**
 * Shared semantics for user-supplied folder selectors (`--folder`), used by
 * backup filtering and by save/restore folder scoping so both behave alike.
 */

import { FOLDER_PATH_SEPARATOR } from '@/adapters/graph-folder-tree-enumerator';
import { trim_slashes } from '@wisecom/atlas-core/services/shared/trim-slashes';
import { NotFoundError } from '@wisecom/atlas-types';
import type { ExcludedFolder, MailboxConnector, MailFolder } from '@wisecom/atlas-types';

/** The fields a folder selector reads: the folder's path and its well-known role, if any. */
export type SelectableFolder = Pick<MailFolder, 'folder_id' | 'folder_path' | 'well_known_name'>;

/** Lowercases a selector and drops surrounding slashes and whitespace. */
function normalize_selector(selector: string): string {
  return trim_slashes(selector.toLowerCase()).trim();
}

/**
 * True when `selector` selects `folder_path`.
 *
 * Matching is case-insensitive and accepts either a full path
 * (`Inbox/Projects`) or a bare folder name (`Projects`, matched at any depth).
 * Selecting a folder always selects everything nested beneath it, so
 * `--folder Inbox` covers `Inbox/Projects/2026`.
 */
export function folder_matches_selector(folder_path: string, selector: string): boolean {
  const wanted = normalize_selector(selector);
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
 * Returns the folders `selector` selects: by path or bare name, as {@link folder_matches_selector}
 * matches them, or by a Graph well-known name such as `inbox` or `sentitems`. Display names are
 * localised, so the well-known name is the one selector that names the same folder in a mailbox of
 * any language. A well-known match selects the folder's subtree too.
 */
export function select_folders<T extends SelectableFolder>(
  folders: readonly T[],
  selector: string,
): T[] {
  const role_paths = well_known_folder_paths(folders, selector);
  return folders.filter(
    (folder) =>
      folder_matches_selector(folder.folder_path, selector) ||
      role_paths.some((role_path) => is_same_or_nested_path(folder.folder_path, role_path)),
  );
}

/** Lowercased paths of the folders whose well-known name is `selector`. */
function well_known_folder_paths(folders: readonly SelectableFolder[], selector: string): string[] {
  const wanted = normalize_selector(selector);
  return folders
    .filter((folder) => folder.well_known_name === wanted)
    .map((folder) => folder.folder_path.toLowerCase());
}

/** True when `folder_path` is `ancestor_path` (lowercased) or lies beneath it. */
function is_same_or_nested_path(folder_path: string, ancestor_path: string): boolean {
  const path = folder_path.toLowerCase();
  return path === ancestor_path || path.startsWith(`${ancestor_path}${FOLDER_PATH_SEPARATOR}`);
}

/** Describes a selector that matched no folder, naming the folders that do exist. */
export function describe_unmatched_folder_selector(
  selector: string,
  folders: readonly SelectableFolder[],
): string {
  const available = folders.map((folder) => folder.folder_path).join(', ');
  return `Folder "${selector}" not found. Available: ${available}`;
}

/** The folders a set of selectors chose, and the selectors that chose none. */
export interface FolderSelection {
  readonly folders: MailFolder[];
  readonly unmatched_selectors: string[];
}

/** Filters mailbox folders by user selectors and lists the selectors that matched nothing. */
export function apply_folder_filter(folders: MailFolder[], filter?: string[]): FolderSelection {
  if (!filter || filter.length === 0) return { folders, unmatched_selectors: [] };

  const selected = new Set<MailFolder>();
  const unmatched_selectors: string[] = [];
  for (const selector of filter) {
    const matches = select_folders(folders, selector);
    if (matches.length === 0) unmatched_selectors.push(selector);
    for (const folder of matches) selected.add(folder);
  }
  return { folders: folders.filter((folder) => selected.has(folder)), unmatched_selectors };
}

/**
 * Throws when the operator's selectors chose no folder at all, so a run that would back up
 * nothing fails instead of storing an empty snapshot and exiting 0 (issue #707).
 */
export function assert_some_folder_selected(
  selection: FolderSelection,
  all_folders: readonly MailFolder[],
): void {
  if (selection.folders.length > 0 || selection.unmatched_selectors.length === 0) return;
  const selectors = selection.unmatched_selectors.map((selector) => `"${selector}"`).join(', ');
  const available = all_folders.map((folder) => folder.folder_path).join(', ');
  throw new NotFoundError(`No folder matches ${selectors}. Available: ${available}`);
}

export interface ResolvedBackupFolders {
  readonly folders: MailFolder[];
  /** One error per selector that matched no folder, for a run where other selectors matched. */
  readonly selector_errors: string[];
  /** Folders the connector pruned, for the manifest and the run summary. */
  readonly excluded: ExcludedFolder[];
}

/**
 * Lists the folders a backup should walk: everything the connector returns,
 * narrowed by the operator's `--folder` selectors. Throws `NotFoundError` when
 * the selectors match no folder at all.
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
  assert_some_folder_selected(selection, all_folders);
  const selector_errors = selection.unmatched_selectors.map((selector) =>
    describe_unmatched_folder_selector(selector, all_folders),
  );
  return { folders: selection.folders, selector_errors, excluded };
}
