import { NotFoundError } from '@wisecom/atlas-types';
import type { DriveManifestEntry } from '@/drive-ports';
import { join_drive_path } from '@/shared/logical-path';

/** The entries a file filter selected, and the filter values that selected none. */
export interface DriveEntrySelection {
  readonly entries: DriveManifestEntry[];
  readonly unmatched_filters: string[];
}

/** Filters manifest entries by file ID or full path, case-insensitively. */
export function filter_drive_entries(
  entries: readonly DriveManifestEntry[],
  file_filter?: string[],
): DriveEntrySelection {
  if (!file_filter || file_filter.length === 0) {
    return { entries: [...entries], unmatched_filters: [] };
  }
  const selected = new Set(file_filter.map((value) => value.toLowerCase()));
  const known_keys = new Set(entries.flatMap(entry_selector_keys));
  return {
    entries: entries.filter((entry) => entry_selector_keys(entry).some((key) => selected.has(key))),
    unmatched_filters: file_filter.filter((value) => !known_keys.has(value.toLowerCase())),
  };
}

/** The lowercased file ID and full path a filter value can name an entry by. */
function entry_selector_keys(entry: DriveManifestEntry): string[] {
  return [
    entry.file_id.toLowerCase(),
    join_drive_path(entry.parent_path, entry.file_name).toLowerCase(),
  ];
}

/**
 * Selects the entries a file filter names. Throws `NotFoundError` when the filter matched no file
 * at all, so a mistyped `--file-filter` fails before any write instead of restoring or saving
 * nothing and exiting 0 (issue #707). Values that matched nothing while others matched are
 * returned for the caller to report.
 */
export function select_drive_entries(
  entries: readonly DriveManifestEntry[],
  file_filter?: string[],
): DriveEntrySelection {
  const selection = filter_drive_entries(entries, file_filter);
  if (selection.entries.length === 0 && selection.unmatched_filters.length > 0) {
    const values = selection.unmatched_filters.map((value) => `"${value}"`).join(', ');
    throw new NotFoundError(`No file in the snapshot matches ${values}`);
  }
  return selection;
}

/** Records on a run result the file filter values that matched nothing; unchanged when none. */
export function with_unmatched_file_filters<T extends object>(
  result: T,
  unmatched_filters: readonly string[],
): T & { readonly unmatched_file_filters?: string[] } {
  if (unmatched_filters.length === 0) return result;
  return { ...result, unmatched_file_filters: [...unmatched_filters] };
}
