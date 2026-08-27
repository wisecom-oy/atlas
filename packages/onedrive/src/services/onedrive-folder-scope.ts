/**
 * Folder scoping for OneDrive backup.
 *
 * Graph's `driveItem` delta is drive-wide, so a scope cannot be pushed into the
 * query: it is applied to the delta result instead. Enumeration therefore still
 * pages the whole drive, but nothing outside the scope is downloaded, hashed,
 * version-synced or written, which is where a drive backup actually spends its
 * time. Narrowing the enumeration itself would need `/items/{id}/delta`, a
 * different cursor shape, and is not required for the cost this removes.
 */

import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
import type { OneDriveDeltaResult } from '@wisecom/atlas-types';

/**
 * Normalises a caller-supplied folder path to the shape `parent_path` carries:
 * NFC, a single leading slash, no trailing slash. Returns undefined for the
 * drive root, since scoping to the root is the same as not scoping at all.
 */
export function normalize_folder_scope(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '/') return undefined;
  const with_leading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const without_trailing = with_leading.endsWith('/') ? with_leading.slice(0, -1) : with_leading;
  return without_trailing.normalize('NFC');
}

/**
 * True when a delta item lives inside the scoped subtree.
 *
 * A removed item is judged by its remembered path, not its current one: Graph
 * omits `parentReference` for a deletion (issue #139), so filtering those on
 * `parent_path` would drop the deletion of an in-scope file and leave the
 * snapshot claiming a file that is gone.
 */
export function is_within_folder_scope(
  item: OneDriveDeltaItem,
  scope: string,
  previous_path_by_file_id: Record<string, string>,
): boolean {
  const path = item.deleted
    ? (previous_path_by_file_id[item.item_id] ?? item.parent_path)
    : item.parent_path;
  return path === scope || path.startsWith(`${scope}/`);
}

/**
 * Narrows a delta result to the scoped subtree, or returns it untouched when there is no scope.
 *
 * Kept out of the drive scan loop so the scan reads as one flow: the loop asks for the items it
 * should process and does not branch on whether a scope exists.
 */
export function scoped_delta(
  delta: OneDriveDeltaResult,
  scope: string | undefined,
  previous_path_by_file_id: Record<string, string>,
): OneDriveDeltaResult {
  if (scope === undefined) return delta;
  return {
    ...delta,
    items: delta.items.filter((item) =>
      is_within_folder_scope(item, scope, previous_path_by_file_id),
    ),
  };
}
