import type { PendingVersionCapture } from '@wisecom/atlas-types';
import { append_all } from '@wisecom/atlas-core/utils/append-all';
import type { DriveFileVersionRecord, DriveVersionWatermark } from '@/drive-ports';
import type { VersionSyncOutcome } from '@/versioning/version-sync';

/**
 * Per-run version bookkeeping shared by every delta item of a backup. `watermarks` is carried in
 * and out through the delta cursor, so version dedup costs no index reads at all; `rows`
 * accumulates what this run captured for its single index object (issue #161).
 */
export interface RunVersionCollector {
  watermarks: Record<string, DriveVersionWatermark | string>;
  /** Files whose version capture has not finished, carried through the delta cursor (issue #858). */
  pending: Record<string, PendingVersionCapture>;
  rows: Map<string, DriveFileVersionRecord[]>;
}

/**
 * Records what one file's sync captured: the index rows for this run, the advanced watermark, and
 * whether the file still owes versions. Writing the watermark back immediately also means a file
 * that appears twice in one delta cycle is not downloaded twice.
 *
 * A file with a failed version stays pending, so the next run that sees it lists its versions again
 * even when the file's content deduplicates.
 */
export function collect_run_versions(
  versions: RunVersionCollector,
  file_id: string,
  outcome: VersionSyncOutcome,
): void {
  if (outcome.records.length > 0) {
    const rows = versions.rows.get(file_id);
    if (rows) append_all(rows, outcome.records);
    else versions.rows.set(file_id, [...outcome.records]);
  }
  if (outcome.next_watermark !== undefined) {
    versions.watermarks[file_id] = outcome.next_watermark;
  }
  if (outcome.versions_failed === 0) {
    delete versions.pending[file_id];
  } else {
    versions.pending[file_id] = outcome.not_found ? { not_found: outcome.not_found } : {};
  }
}

/** Drops a deleted file's unfinished capture: Graph has no history left to read for it. */
export function forget_pending_versions(versions: RunVersionCollector, file_id: string): void {
  delete versions.pending[file_id];
}
