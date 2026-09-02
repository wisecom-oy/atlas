import type {
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveManifestEntry,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  accumulate_version_stats,
  build_deleted_entry,
  build_stored_entry,
} from '@/services/backup/backup-builders';
import { process_backup_file } from '@/services/backup/backup-file-processor';
import { is_download_refused } from '@wisecom/atlas-m365-graph';
import { classify_change_type } from '@/services/backup/change-classifier';
import {
  collect_run_versions,
  sync_file_versions,
  type RunVersionCollector,
} from '@/services/versioning/version-sync';

export interface DriveTrackingState {
  previous_path_by_file_id: Record<string, string>;
  previous_name_by_file_id: Record<string, string>;
  previous_etag_by_file_id: Record<string, string>;
  previous_kind_by_file_id: Record<string, 'file' | 'folder'>;
}

export interface VersionStats {
  total_versions_stored: number;
  total_versions_unavailable: number;
  total_versions_failed: number;
}

export interface DeltaItemOutcome {
  entry?: OneDriveManifestEntry;
  files_stored: number;
  files_deduplicated: number;
  deleted_items: number;
  error?: string;
  /** The error is a policy refusal, so retrying it on later runs is pointless. */
  permanent?: boolean;
}

/**
 * Forgets tracking for the files a reset re-enumerates, so they rebaseline as
 * `created`.
 *
 * Scoped to the ids the resetting delta returned rather than the whole map. The
 * maps are keyed by file id alone and shared by every drive an owner has, so
 * clearing all of them let one drive's dead delta link wipe its siblings' path,
 * name and etag records, and a genuine change elsewhere then looked like a first
 * backup (issue #199). With `--folder` in play the delta is already scoped, so
 * this also stops a reset from forgetting files outside the scope it never read.
 *
 * A reset delta is a full enumeration, so its ids are exactly the entries that
 * need forgetting. That holds for cursors written before this fix too, which is
 * why nothing has to be migrated.
 */
export function clear_file_tracking_on_reset(
  state: DriveTrackingState,
  reset_item_ids: Iterable<string>,
): void {
  for (const fid of reset_item_ids) {
    if (state.previous_kind_by_file_id[fid] === 'file') {
      delete state.previous_path_by_file_id[fid];
      delete state.previous_name_by_file_id[fid];
      delete state.previous_etag_by_file_id[fid];
    }
  }
}

/** Processes one delta item and returns manifest entries or errors. */
export async function process_delta_item(
  connector: OneDriveConnector,
  item: OneDriveDeltaItem,
  owner_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  state: DriveTrackingState,
  version_stats: VersionStats,
  on_version_stats_update: (stored: number, unavailable: number, failed: number) => void,
  versions: RunVersionCollector,
): Promise<DeltaItemOutcome> {
  const effective_kind =
    item.deleted && item.kind === 'file' && state.previous_kind_by_file_id[item.item_id]
      ? state.previous_kind_by_file_id[item.item_id]
      : item.kind;

  if (effective_kind !== 'file') {
    if (!item.deleted) state.previous_kind_by_file_id[item.item_id] = item.kind;
    return { files_stored: 0, files_deduplicated: 0, deleted_items: 0 };
  }

  const change_type = classify_change_type(
    item,
    state.previous_path_by_file_id,
    state.previous_name_by_file_id,
    state.previous_etag_by_file_id,
  );
  if (!change_type) {
    return { files_stored: 0, files_deduplicated: 0, deleted_items: 0 };
  }

  if (item.deleted) {
    // Graph omits `name` for a removed item, so the last name we saw is the
    // only one there is (issue #139).
    const file_name = item.file_name || (state.previous_name_by_file_id[item.item_id] ?? '');
    return {
      entry: build_deleted_entry({ ...item, file_name }, change_type),
      files_stored: 0,
      files_deduplicated: 0,
      deleted_items: 1,
    };
  }

  // Quarantined content is never served, so attempting the download only burns
  // the Graph retry budget: the refusal arrives as an aborted transfer, which
  // `is_network_error` classifies as retryable, and a single blocked file can
  // then hold a backup for the full ~23 minute budget (issue #53).
  if (item.quarantined === true) {
    return {
      files_stored: 0,
      files_deduplicated: 0,
      deleted_items: 0,
      error: `Quarantined by Microsoft 365 malware policy: ${item.file_name} (${item.item_id})`,
      permanent: true,
    };
  }

  const download = await download_or_record_refusal(connector, item, owner_id, ctx);
  if (download.outcome) return download.outcome;
  const result = download.result;

  if (!result.deduplicated) {
    const version_result = await sync_file_versions(
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      versions.watermarks[item.item_id],
    );
    collect_run_versions(versions, item.item_id, version_result);
    accumulate_version_stats(version_result, version_stats, on_version_stats_update);
  }
  state.previous_path_by_file_id[item.item_id] = item.parent_path;
  state.previous_name_by_file_id[item.item_id] = item.file_name;
  state.previous_kind_by_file_id[item.item_id] = 'file';
  if (item.etag) state.previous_etag_by_file_id[item.item_id] = item.etag;

  return {
    entry: build_stored_entry(item, result.storage_key, result.checksum, change_type),
    files_stored: result.stored ? 1 : 0,
    files_deduplicated: result.deduplicated ? 1 : 0,
    deleted_items: 0,
  };
}

/**
 * Downloads one item, converting a service refusal into a recorded outcome.
 *
 * A refusal is permanent for this item but not for the run, so it is recorded the
 * way a quarantined item is. A missing grant is deliberately not caught: it applies
 * to every item and must stop the run (issue #246).
 */
async function download_or_record_refusal(
  connector: OneDriveConnector,
  item: OneDriveDeltaItem,
  owner_id: string,
  ctx: TenantContext,
): Promise<
  | { outcome: DeltaItemOutcome; result?: undefined }
  | { outcome?: undefined; result: NonNullable<Awaited<ReturnType<typeof process_backup_file>>> }
> {
  const empty = { files_stored: 0, files_deduplicated: 0, deleted_items: 0 };
  try {
    const result = await process_backup_file(connector, item, owner_id, ctx);
    if (result) return { result };
    return {
      outcome: { ...empty, error: `Failed to process file ${item.file_name} (${item.item_id})` },
    };
  } catch (err) {
    if (!is_download_refused(err)) throw err;
    return { outcome: { ...empty, error: err.message, permanent: true } };
  }
}
