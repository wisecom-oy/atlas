import type {
  DriveEntryKind,
  DriveFolderColor,
  OneDriveChangeType,
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
import { resolve_backed_up_kind } from '@wisecom/atlas-drive';
import { spares_failed_item_attempt } from '@wisecom/atlas-drive/backup/transient-download-failure';
import { classify_change_type } from '@/services/backup/change-classifier';
import { process_folder_item } from '@wisecom/atlas-drive/backup/folder-item-processor';
import {
  permission_digests,
  record_file_permission_digest,
  with_captured_permissions,
  type DriveSharingCapture,
  type PermissionObservation,
} from '@wisecom/atlas-drive/backup/sharing-capture';
import {
  create_item_metadata_capture,
  type DriveItemMetadataCapture,
} from '@wisecom/atlas-drive/backup/item-metadata-capture';
import { plan_sharing_only_change } from '@wisecom/atlas-drive/backup/sharing-only-change';
import {
  capture_owed_file_versions,
  forget_pending_versions,
  type RunVersionCollector,
} from '@/services/versioning/version-sync';

export interface DriveTrackingState {
  previous_path_by_file_id: Record<string, string>;
  previous_name_by_file_id: Record<string, string>;
  previous_etag_by_file_id: Record<string, string>;
  previous_kind_by_file_id: Record<string, DriveEntryKind>;
  /** Digest of each item's captured permissions; see `OneDriveDeltaCursor`. */
  permission_digest_by_item_id?: Record<string, string>;
  /** Colour of each coloured folder's newest entry; see `OneDriveDeltaCursor`. */
  folder_color_by_item_id?: Record<string, DriveFolderColor>;
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
  /**
   * False when the failure was outside the file (an expired download URL, throttling, an outage, a
   * reset or a timeout), so the ledger does not count an attempt (issues #718, #857).
   */
  consumes_attempt?: boolean;
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
  const digests = permission_digests(state);
  for (const fid of reset_item_ids) {
    delete digests[fid];
    if (state.previous_kind_by_file_id[fid] === 'file') {
      delete state.previous_path_by_file_id[fid];
      delete state.previous_name_by_file_id[fid];
      delete state.previous_etag_by_file_id[fid];
    }
  }
}

const NOTHING: DeltaItemOutcome = { files_stored: 0, files_deduplicated: 0, deleted_items: 0 };

/** The outcome of an item that wrote at most an entry and stored no content. */
function entry_only(entry: OneDriveManifestEntry | undefined): DeltaItemOutcome {
  return entry ? { ...NOTHING, entry } : NOTHING;
}

/**
 * Processes one delta item and returns manifest entries or errors. Folders go to the shared folder
 * processor; files are downloaded when their content changed, or recorded with the earlier blob
 * when only their sharing did.
 */
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
  abort_signal?: AbortSignal,
  capture: DriveItemMetadataCapture = create_item_metadata_capture(connector),
): Promise<DeltaItemOutcome> {
  const effective_kind = resolve_backed_up_kind(item, state.previous_kind_by_file_id);
  if (effective_kind === 'folder') {
    return entry_only(await process_folder_item(item, state, capture));
  }

  const classified = classify_change_type(
    item,
    state.previous_path_by_file_id,
    state.previous_name_by_file_id,
    state.previous_etag_by_file_id,
  );

  if (item.deleted) {
    forget_pending_versions(versions, item.item_id);
    if (!classified) return NOTHING;
    delete permission_digests(state)[item.item_id];
    // Graph omits `name` for a removed item, so the last name we saw is the
    // only one there is (issue #139).
    const file_name = item.file_name || (state.previous_name_by_file_id[item.item_id] ?? '');
    return {
      entry: build_deleted_entry({ ...item, file_name }, classified),
      files_stored: 0,
      files_deduplicated: 0,
      deleted_items: 1,
    };
  }

  const observation = await capture.sharing.observe(item, state);
  const change_type =
    classified ?? (await sharing_only_change(item, observation, state, capture.sharing));
  if (change_type === undefined) return NOTHING;
  if (typeof change_type !== 'string') return entry_only(change_type.entry);

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

  const download = await download_or_record_refusal(connector, item, owner_id, ctx, abort_signal);
  if (download.outcome) return download.outcome;
  const result = download.result;

  // Deduplicated content still owes versions when an earlier run stopped before capturing them.
  const version_result = await capture_owed_file_versions(
    connector,
    item,
    owner_id,
    snapshot_id,
    ctx,
    versions,
    result.deduplicated,
    abort_signal,
  );
  if (version_result) {
    accumulate_version_stats(version_result, version_stats, on_version_stats_update);
  }
  state.previous_path_by_file_id[item.item_id] = item.parent_path;
  state.previous_name_by_file_id[item.item_id] = item.file_name;
  state.previous_kind_by_file_id[item.item_id] = 'file';
  if (item.etag) state.previous_etag_by_file_id[item.item_id] = item.etag;

  record_file_permission_digest(state, item.item_id, observation);

  return {
    // The stored length, which is the refreshed size when the file grew on its first download (#759).
    entry: with_captured_permissions(
      build_stored_entry(
        { ...item, size_bytes: result.size_bytes },
        result.storage_key,
        result.checksum,
        change_type,
      ),
      observation,
    ),
    files_stored: result.stored ? 1 : 0,
    files_deduplicated: result.deduplicated ? 1 : 0,
    deleted_items: 0,
  };
}

/**
 * What to do with a file whose content and location did not change: nothing, an entry carrying its
 * new permissions over the earlier blob, or (`updated`) a download when no earlier blob is known.
 */
async function sharing_only_change(
  item: OneDriveDeltaItem,
  observation: PermissionObservation,
  state: DriveTrackingState,
  sharing: DriveSharingCapture,
): Promise<OneDriveChangeType | { entry: OneDriveManifestEntry } | undefined> {
  const plan = await plan_sharing_only_change(item, observation, sharing);
  if (plan.kind === 'none') return undefined;
  if (plan.kind === 'download') return 'updated';
  record_file_permission_digest(state, item.item_id, observation);
  return { entry: plan.entry };
}

/**
 * Downloads one item, converting a service refusal into a recorded outcome.
 *
 * A refusal is permanent for this item but not for the run, so it is recorded the
 * way a quarantined item is. A missing grant is deliberately not caught: it applies
 * to every item and must stop the run (issue #246). A failure outside the file is
 * recorded without spending an attempt (issues #718, #857).
 */
async function download_or_record_refusal(
  connector: OneDriveConnector,
  item: OneDriveDeltaItem,
  owner_id: string,
  ctx: TenantContext,
  abort_signal?: AbortSignal,
): Promise<
  | { outcome: DeltaItemOutcome; result?: undefined }
  | { outcome?: undefined; result: NonNullable<Awaited<ReturnType<typeof process_backup_file>>> }
> {
  const empty = { files_stored: 0, files_deduplicated: 0, deleted_items: 0 };
  try {
    const result = await process_backup_file(connector, item, owner_id, ctx, abort_signal);
    if (result) return { result };
    return {
      outcome: { ...empty, error: `Failed to process file ${item.file_name} (${item.item_id})` },
    };
  } catch (err) {
    if (spares_failed_item_attempt(err)) {
      return { outcome: { ...empty, error: err.message, consumes_attempt: false } };
    }
    if (!is_download_refused(err)) throw err;
    return { outcome: { ...empty, error: err.message, permanent: true } };
  }
}
