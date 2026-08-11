/**
 * Shared semantics for user-supplied folder selectors (`--folder`), used by
 * backup filtering and by save/restore folder scoping so both behave alike.
 */

import { FOLDER_PATH_SEPARATOR } from '@/adapters/graph-folder-tree-enumerator';

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
