import { is_graph_outage } from '@wisecom/atlas-core/services/shared/graph-outage-latch';
import type {
  DriveEntryKind,
  DriveFolderColor,
  SharePointChangeType,
  SharePointDeltaItem,
  SharePointManifestEntry,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  clear_item_failure,
  record_item_failure,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { FailedItemLedger } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import {
  accumulate_version_stats,
  build_deleted_entry,
  build_stored_entry,
} from '@/services/backup/backup-builders';
import { process_backup_file } from '@/services/backup/backup-file-processor';
import { is_download_refused } from '@wisecom/atlas-m365-graph';
import { is_listed_size_part_limit_refusal } from '@wisecom/atlas-core/services/shared/multipart-part-plan';
import { resolve_backed_up_kind } from '@wisecom/atlas-drive';
import { spares_failed_item_attempt } from '@wisecom/atlas-drive/backup/transient-download-failure';
import { is_storage_failure } from '@wisecom/atlas-drive/backup/storage-failure';
import { classify_change_type } from '@/services/backup/change-classifier';
import { process_folder_item } from '@wisecom/atlas-drive/backup/folder-item-processor';
import {
  type DriveSharingCapture,
  permission_digests,
  record_file_permission_digest,
  with_captured_permissions,
  type PermissionObservation,
} from '@wisecom/atlas-drive/backup/sharing-capture';
import { plan_sharing_only_change } from '@wisecom/atlas-drive/backup/sharing-only-change';
import {
  create_item_metadata_capture,
  type DriveItemMetadataCapture,
} from '@wisecom/atlas-drive/backup/item-metadata-capture';
import {
  capture_owed_file_versions,
  forget_pending_versions,
  type RunVersionCollector,
} from '@/services/versioning/version-sync';

export interface FileTrackingState {
  previous_path_by_file_id: Record<string, string>;
  previous_name_by_file_id: Record<string, string>;
  previous_etag_by_file_id: Record<string, string>;
  previous_kind_by_file_id: Record<string, DriveEntryKind>;
  /** Digest of each item's captured permissions; see `SharePointDeltaCursor`. */
  permission_digest_by_item_id?: Record<string, string>;
  /** Colour of each coloured folder's newest entry; see `SharePointDeltaCursor`. */
  folder_color_by_item_id?: Record<string, DriveFolderColor>;
}

export interface LibraryProcessingState {
  library_entries: SharePointManifestEntry[];
  /** Name of the library being processed, recorded so a cross-site restore can place these entries. */
  library_name: string;
  library_files_stored: number;
  library_files_deduplicated: number;
  library_deleted_items: number;
  /** Site-wide failed-item ledger, updated in place as items succeed or fail. */
  failed_items: FailedItemLedger;
  /**
   * Items that failed in THIS run. The ledger also carries older failures,
   * which say nothing about whether this batch's notebooks came through whole.
   */
  failed_item_ids: Set<string>;
}

export interface VersionStatsState {
  total_versions_stored: number;
  total_versions_unavailable: number;
  total_versions_failed: number;
}

/** What the run reports per processed item: its name, whether it is a file or a folder, and whether it was deleted. */
export type ProcessedItemRef = Pick<SharePointDeltaItem, 'file_name' | 'kind'> &
  Partial<Pick<SharePointDeltaItem, 'deleted'>>;

/** Processes a single delta item and updates library and tracking state. */
export async function process_delta_item(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  tracking: FileTrackingState,
  library_state: LibraryProcessingState,
  versions: RunVersionCollector,
  version_stats: VersionStatsState,
  abort_signal?: AbortSignal,
  capture: DriveItemMetadataCapture = create_item_metadata_capture(connector),
): Promise<void> {
  const effective_kind = resolve_backed_up_kind(item, tracking.previous_kind_by_file_id);
  if (effective_kind !== 'file') {
    const entry = await process_folder_item(item, tracking, capture);
    if (entry)
      library_state.library_entries.push({ ...entry, library_name: library_state.library_name });
    return;
  }

  const classified = classify_change_type(
    item,
    tracking.previous_path_by_file_id,
    tracking.previous_name_by_file_id,
    tracking.previous_etag_by_file_id,
  );

  if (item.deleted) {
    forget_pending_versions(versions, item.item_id);
    if (!classified) return;
    delete permission_digests(tracking)[item.item_id];
    // Graph omits `name` for a removed item, so the last name we saw is the
    // only one there is (issue #139).
    const file_name = item.file_name || (tracking.previous_name_by_file_id[item.item_id] ?? '');
    library_state.library_deleted_items++;
    library_state.library_entries.push(
      build_deleted_entry({ ...item, file_name }, classified, library_state.library_name),
    );
    library_state.failed_items = clear_item_failure(library_state.failed_items, item.item_id);
    return;
  }

  const observation = await capture.sharing.observe(item, tracking);
  const change_type =
    classified ??
    (await sharing_only_change(item, observation, tracking, library_state, capture.sharing));
  if (change_type === undefined) return;

  // Quarantined content is never served, so attempting the download only burns
  // the Graph retry budget: the refusal arrives as an aborted transfer, which
  // `is_network_error` classifies as retryable, and a single blocked file can
  // then hold a backup for the full ~23 minute budget (issue #53).
  if (item.quarantined === true) {
    library_state.failed_item_ids.add(item.item_id);
    library_state.failed_items = record_item_failure(library_state.failed_items, {
      item_id: item.item_id,
      drive_id: item.drive_id,
      name: item.file_name,
      reason: `Quarantined by Microsoft 365 malware policy: ${item.file_name} (${item.item_id})`,
      permanent: true,
    });
    return;
  }

  const result = await download_or_record_refusal(
    connector,
    item,
    site_id,
    ctx,
    library_state,
    abort_signal,
  );
  if (!result) return;

  if (result.deduplicated) library_state.library_files_deduplicated++;
  if (result.stored) library_state.library_files_stored++;

  // Deduplicated content still owes versions when an earlier run stopped before capturing them.
  const version_result = await capture_owed_file_versions(
    connector,
    item,
    site_id,
    snapshot_id,
    ctx,
    versions,
    result.deduplicated,
    abort_signal,
  );
  if (version_result) {
    accumulate_version_stats(version_result, version_stats, (s, u, f) => {
      version_stats.total_versions_stored = s;
      version_stats.total_versions_unavailable = u;
      version_stats.total_versions_failed = f;
    });
  }
  library_state.library_entries.push(
    with_captured_permissions(
      // The stored length, which is the refreshed size when the file grew on its first download (#759).
      build_stored_entry(
        { ...item, size_bytes: result.size_bytes },
        result.storage_key,
        result.checksum,
        change_type,
        library_state.library_name,
      ),
      observation,
    ),
  );
  record_file_permission_digest(tracking, item.item_id, observation);
  library_state.failed_items = clear_item_failure(library_state.failed_items, item.item_id);
  tracking.previous_path_by_file_id[item.item_id] = item.parent_path;
  tracking.previous_name_by_file_id[item.item_id] = item.file_name;
  tracking.previous_kind_by_file_id[item.item_id] = 'file';
  if (item.etag) tracking.previous_etag_by_file_id[item.item_id] = item.etag;
}

/** Processes one item, recording a ledger failure instead of failing the library. */
export async function process_item_guarded(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  tracking: FileTrackingState,
  library_state: LibraryProcessingState,
  versions: RunVersionCollector,
  version_stats: VersionStatsState,
  abort_signal?: AbortSignal,
  capture?: DriveItemMetadataCapture,
): Promise<void> {
  try {
    await process_delta_item(
      connector,
      item,
      site_id,
      snapshot_id,
      ctx,
      tracking,
      library_state,
      versions,
      version_stats,
      abort_signal,
      capture,
    );
  } catch (err) {
    // A cancelled transfer is the run stopping, not the item failing. Recording it would spend one
    // of the item's five ledger attempts and eventually skip the file for good (issue #344). A Graph
    // outage is not the item's failure either: it fails the library, which keeps its delta link (#881).
    // Nor is a storage failure, such as a full disk or an S3 5xx, as on OneDrive (issue #917).
    if (abort_signal?.aborted === true || is_graph_outage(err) || is_storage_failure(err)) {
      throw err;
    }
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`SharePoint item ${item.item_id} (${item.file_name}) failed: ${reason}`);
    library_state.failed_item_ids.add(item.item_id);
    library_state.failed_items = record_item_failure(library_state.failed_items, {
      item_id: item.item_id,
      drive_id: item.drive_id,
      name: item.file_name,
      reason,
    });
  }
}

/**
 * What to do with a file whose content and location did not change: nothing (undefined), an entry
 * carrying its new permissions over the earlier blob (pushed here, then undefined), or `updated`
 * when no earlier blob is known and the file has to be downloaded.
 */
async function sharing_only_change(
  item: SharePointDeltaItem,
  observation: PermissionObservation,
  tracking: FileTrackingState,
  library_state: LibraryProcessingState,
  sharing: DriveSharingCapture,
): Promise<SharePointChangeType | undefined> {
  const plan = await plan_sharing_only_change(item, observation, sharing);
  if (plan.kind === 'download') return 'updated';
  if (plan.kind === 'entry') {
    library_state.library_entries.push({ ...plan.entry, library_name: library_state.library_name });
    library_state.failed_items = clear_item_failure(library_state.failed_items, item.item_id);
    record_file_permission_digest(tracking, item.item_id, observation);
  }
  return undefined;
}

/**
 * Downloads one item, recording a service refusal against it and returning
 * undefined when there is nothing to store.
 *
 * A refusal is permanent for this item but not for the run, so it is recorded the
 * way a quarantined item is. A missing grant is deliberately not caught: it applies
 * to every item and must stop the run (issue #246). A file too large for the
 * multipart part limit is recorded as permanent too (issue #925). Mirrors the OneDrive twin.
 */
async function download_or_record_refusal(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  ctx: TenantContext,
  library_state: LibraryProcessingState,
  abort_signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof process_backup_file>>> {
  const record = (
    reason: string,
    outcome: { permanent?: boolean; consumes_attempt?: boolean } = {},
  ): undefined => {
    library_state.failed_item_ids.add(item.item_id);
    library_state.failed_items = record_item_failure(library_state.failed_items, {
      item_id: item.item_id,
      drive_id: item.drive_id,
      name: item.file_name,
      reason,
      ...(outcome.permanent === true ? { permanent: true } : {}),
      ...(outcome.consumes_attempt === false ? { consumes_attempt: false } : {}),
    });
    return undefined;
  };

  try {
    const result = await process_backup_file(connector, item, site_id, ctx, abort_signal);
    return result ?? record('file content could not be downloaded');
  } catch (err) {
    // An expired URL or a failure outside the file costs no attempt (issues #718, #857).
    if (spares_failed_item_attempt(err)) return record(err.message, { consumes_attempt: false });
    if (!is_download_refused(err) && !is_listed_size_part_limit_refusal(err)) throw err;
    return record(err.message, { permanent: true });
  }
}
