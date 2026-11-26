import type {
  DriveChangeType,
  DriveFileVersionIndexView,
  DriveFileVersionRecord,
} from '@/drive-ports';
import { records_file_content } from '@/shared/entry-kind';
import type { FoldableDriveEntry } from '@/retention/drive-baseline-fold';

/** The fields of a manifest entry that its version index row repeats. */
export interface RowSourceEntry extends FoldableDriveEntry {
  readonly change_type: DriveChangeType;
  readonly drive_id: string;
  readonly file_name: string;
  readonly parent_path: string;
  readonly backup_at: string;
  readonly web_url?: string | undefined;
  readonly storage_key?: string | undefined;
  readonly checksum?: string | undefined;
  readonly etag?: string | undefined;
  readonly last_modified_at?: string | undefined;
}

/**
 * The run index of a baseline with a row for every entry it now carries.
 *
 * Verification looks for each file's row under the snapshot that recorded its entry, and after a
 * fold that is the baseline: the row the original run wrote is under a snapshot the prune
 * removes. So each content entry of the baseline that has no row under the baseline's id in
 * `history` gets one, built from the entry the way a backup builds it. Undefined when nothing is
 * missing, so a repeated run writes nothing.
 *
 * @param stored The baseline's run index as stored now; empty when it has none.
 * @param history Every file's rows across all index objects of the owner.
 */
export function baseline_run_index(
  snapshot_id: string,
  entries: readonly RowSourceEntry[],
  stored: readonly DriveFileVersionIndexView[],
  history: readonly DriveFileVersionIndexView[],
): DriveFileVersionIndexView[] | undefined {
  const has_row = files_with_row_under(snapshot_id, history);
  const missing = entries.filter(
    (entry) => records_file_content(entry) && !has_row.has(entry.file_id),
  );
  if (missing.length === 0) return undefined;

  const rows = new Map(stored.map((index) => [index.file_id, [...index.versions]]));
  for (const entry of missing) {
    const versions = rows.get(entry.file_id) ?? [];
    versions.push(entry_row(snapshot_id, entry));
    rows.set(entry.file_id, versions);
  }
  return [...rows].map(([file_id, versions]) => ({ file_id, versions }));
}

function files_with_row_under(
  snapshot_id: string,
  history: readonly DriveFileVersionIndexView[],
): Set<string> {
  const files = new Set<string>();
  for (const index of history) {
    if (index.versions.some((row) => row.snapshot_id === snapshot_id)) files.add(index.file_id);
  }
  return files;
}

/** The row a backup writes for a manifest entry: the file's state when the entry was recorded. */
function entry_row(snapshot_id: string, entry: RowSourceEntry): DriveFileVersionRecord {
  return {
    snapshot_id,
    backup_at: entry.backup_at,
    drive_id: entry.drive_id,
    file_name: entry.file_name,
    parent_path: entry.parent_path,
    size_bytes: entry.size_bytes,
    change_type: entry.change_type,
    ...(entry.web_url !== undefined && { web_url: entry.web_url }),
    ...(entry.storage_key !== undefined && { storage_key: entry.storage_key }),
    ...(entry.checksum !== undefined && { checksum: entry.checksum }),
    ...(entry.etag !== undefined && { etag: entry.etag }),
    ...(entry.last_modified_at !== undefined && { last_modified_at: entry.last_modified_at }),
  };
}
