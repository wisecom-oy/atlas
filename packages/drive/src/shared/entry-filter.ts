import type { DriveManifestEntry } from '@/drive-ports';

/** Filters manifest entries by file ID or full path, case-insensitively. */
export function filter_drive_entries(
  entries: readonly DriveManifestEntry[],
  file_filter?: string[],
): DriveManifestEntry[] {
  if (!file_filter || file_filter.length === 0) return [...entries];
  const selected = new Set(file_filter.map((value) => value.toLowerCase()));
  return entries.filter(
    (entry) =>
      selected.has(entry.file_id.toLowerCase()) ||
      selected.has(`${entry.parent_path}/${entry.file_name}`.toLowerCase()),
  );
}
