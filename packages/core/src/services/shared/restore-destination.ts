/**
 * Destination handling for the drive restore pipelines.
 *
 * A drive restore used to write every file back to the path it was backed up from, directly into
 * live user content. With the default `rename` conflict policy nothing failed and nothing was
 * overwritten; each run simply left another suffixed copy beside every original, scattered across
 * the tree with no handle to undo it. Nesting a restore under a generated root makes it separable
 * from live data and reversible by deleting one folder, which is what Outlook restores have always
 * done. The timestamp format matches `create_restore_root` so the two workloads read alike.
 */

/** Caller's choice of restore destination; both fields absent means the generated root. */
export interface RestoreDestinationOptions {
  readonly destination?: string;
  readonly in_place?: boolean;
}

/**
 * Root that restored paths are nested under. An empty string restores to the original locations,
 * which `--in-place` and an explicit destination of `/` both mean: nesting under the drive root is
 * the original layout by definition.
 */
export function resolve_restore_root(options: RestoreDestinationOptions): string {
  if (options.in_place === true) return '';
  const chosen = options.destination?.trim();
  if (chosen !== undefined && chosen.length > 0) return normalize_root(chosen);
  return `/Restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}

/**
 * Joins a restore root with a manifest `parent_path`, preserving the original nesting beneath it.
 * A file from `/Projects/2026` lands in `/Restore-.../Projects/2026`.
 */
export function restore_parent_path(root: string, parent_path: string): string {
  if (root.length === 0) return parent_path;
  const nested = parent_path === '.' ? '' : parent_path.replace(/^\/+/, '');
  return nested.length === 0 ? root : `${root}/${nested}`;
}

/**
 * Refuses a rename that cannot mean one thing. Renaming many files to one name would either
 * collide or silently rename the first and leave the rest, so the restore is rejected before any
 * file is written rather than halfway through.
 */
export function assert_renameable(rename_to: string | undefined, file_count: number): void {
  if (rename_to !== undefined && file_count !== 1) {
    throw new Error(
      `--name renames a single file, but this restore resolves to ${file_count} files; ` +
        'narrow it with --file-filter',
    );
  }
}

function normalize_root(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  return trimmed.length === 0 ? '' : `/${trimmed}`;
}
