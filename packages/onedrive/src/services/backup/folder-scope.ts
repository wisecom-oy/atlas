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

import type { OneDriveDeltaCursor, OneDriveDeltaItem } from '@wisecom/atlas-types';
import type { OneDriveDeltaResult } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

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
 * Whether the run's folder scope differs from the one the stored cursor was advanced under,
 * logging the re-crawl it causes.
 *
 * A delta link records how far the drive was consumed, not how far the scope was, so resuming one
 * under a different scope would skip changes the previous run filtered out.
 */
export function has_folder_scope_changed(
  stored_cursor: Pick<OneDriveDeltaCursor, 'folder_scope'> | undefined,
  folder_scope: string | undefined,
): boolean {
  const scope_changed = (stored_cursor?.folder_scope ?? undefined) !== folder_scope;
  if (scope_changed && stored_cursor !== undefined) {
    logger.info(
      `Folder scope changed (${stored_cursor.folder_scope ?? 'whole drive'} -> ` +
        `${folder_scope ?? 'whole drive'}); re-crawling instead of resuming the delta link`,
    );
  }
  return scope_changed;
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
  return is_path_within_folder_scope(path, scope);
}

/** True when a `parent_path` is the scope folder itself or lies beneath it. */
export function is_path_within_folder_scope(path: string, scope: string): boolean {
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
