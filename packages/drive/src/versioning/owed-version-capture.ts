import type { TenantContext } from '@wisecom/atlas-types';
import type { DriveContentConnector, DriveDeltaItem } from '@/drive-ports';
import type { DriveStorageKeys } from '@/shared/storage-keys';
import { collect_run_versions, type RunVersionCollector } from '@/versioning/run-version-collector';
import { sync_file_versions, type VersionSyncOutcome } from '@/versioning/version-sync';

/**
 * Whether a file's history has to be captured now: its content was just stored, or an earlier
 * capture of it did not finish.
 *
 * Content that is already in storage does not mean the change was fully processed. A run that
 * stored the content and then stopped before the versions were captured (a failed drive, a failed
 * item, Ctrl+C) leaves the content behind, and the rerun finds it deduplicated (issue #858). The
 * pending record is what tells the two apart. A deduplicated file without one, the steady state of
 * a re-enumeration, costs no version request.
 */
export function owes_version_capture(
  versions: RunVersionCollector,
  file_id: string,
  content_deduplicated: boolean,
): boolean {
  return !content_deduplicated || versions.pending[file_id] !== undefined;
}

/**
 * Captures the file's historical versions when it owes them, and records the result in the run's
 * bookkeeping. Returns `undefined` when nothing was owed and Graph was not asked.
 *
 * The file is marked pending before the capture starts and cleared only when it finishes with no
 * failed version, so a capture that throws part way leaves the file owed for the next run. The
 * watermark keeps that repeat cheap: versions already captured are not downloaded again.
 */
export async function capture_owed_file_versions(
  keys: DriveStorageKeys,
  connector: DriveContentConnector,
  item: DriveDeltaItem,
  owner_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  versions: RunVersionCollector,
  content_deduplicated: boolean,
  abort_signal?: AbortSignal,
): Promise<VersionSyncOutcome | undefined> {
  if (!owes_version_capture(versions, item.item_id, content_deduplicated)) return undefined;
  const pending = versions.pending[item.item_id];
  versions.pending[item.item_id] = pending ?? {};
  const outcome = await sync_file_versions(
    keys,
    connector,
    item,
    owner_id,
    snapshot_id,
    ctx,
    { watermark: versions.watermarks[item.item_id], not_found: pending?.not_found },
    abort_signal,
  );
  collect_run_versions(versions, item.item_id, outcome);
  return outcome;
}
