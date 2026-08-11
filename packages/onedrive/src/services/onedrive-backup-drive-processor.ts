import type {
  BackupProgressReporter,
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveDeltaResult,
  OneDriveDrive,
  OneDriveDeltaCursorRepository,
  OneDriveFileVersionIndexRepository,
  OneDriveManifestEntry,
  TenantContext,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  clear_item_failure,
  record_item_failure,
  type FailedItemLedger,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import {
  clear_file_tracking_on_reset,
  process_delta_item,
  type DriveTrackingState,
  type VersionStats,
} from '@/services/onedrive-delta-item-processor';
import { resolve_retry_items } from '@/services/onedrive-failed-item-retry';
import {
  make_item_progress_callback,
  report_drive_success,
  type ScanProgressTotals,
} from '@/services/onedrive-scan-progress';

export interface SingleDriveResult {
  entries: OneDriveManifestEntry[];
  files_stored: number;
  files_deduplicated: number;
  deleted_items: number;
  delta_link?: string;
  /** Ledger after this drive: new failures recorded, recovered items cleared. */
  failed_items: FailedItemLedger;
  /** Reason per item that failed this run. */
  errors: string[];
}

export interface DriveScanAccumulators {
  entries: OneDriveManifestEntry[];
  files_stored: number;
  files_deduplicated: number;
  deleted_items: number;
  /** Items still not backed up, carried into the saved cursor and reported. */
  failed_items: FailedItemLedger;
  /** Drive-level failures. Per-item failures live in `failed_items` instead. */
  errors: string[];
}

/** Fetches delta changes across all drives and accumulates manifest entries. */
export async function scan_all_drives(
  connector: OneDriveConnector,
  file_indexes: OneDriveFileVersionIndexRepository,
  cursors: OneDriveDeltaCursorRepository,
  drives: OneDriveDrive[],
  tenant_id: string,
  owner_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  tracking_state: DriveTrackingState,
  delta_link_by_drive: Record<string, string>,
  previous_cursor:
    | { delta_link_by_drive: Record<string, string>; failed_items?: FailedItemLedger | undefined }
    | undefined,
  force_full: boolean,
  version_stats: VersionStats,
  on_version_stats_update: (stored: number, unavailable: number, failed: number) => void,
  progress?: BackupProgressReporter,
): Promise<DriveScanAccumulators> {
  const accumulators: DriveScanAccumulators = {
    entries: [],
    files_stored: 0,
    files_deduplicated: 0,
    deleted_items: 0,
    failed_items: { ...(previous_cursor?.failed_items ?? {}) },
    errors: [],
  };

  const totals: ScanProgressTotals = { processed: 0, total: 0, started_at: Date.now() };

  for (const [index, drive] of drives.entries()) {
    try {
      const prev_delta = force_full
        ? undefined
        : previous_cursor?.delta_link_by_drive[drive.drive_id];
      progress?.update_paging(index, 0, 0, 0);
      const delta = await connector.fetch_delta(tenant_id, owner_id, drive.drive_id, prev_delta);
      progress?.set_row_total?.(index, delta.items.length);
      totals.total += delta.items.length;
      progress?.mark_active(index);

      const versions_before = version_stats.total_versions_stored;
      const on_item_processed = make_item_progress_callback(progress, index, totals);

      const drive_result = await process_single_drive(
        connector,
        file_indexes,
        drive,
        tenant_id,
        owner_id,
        snapshot_id,
        ctx,
        tracking_state,
        delta,
        accumulators.failed_items,
        version_stats,
        on_version_stats_update,
        on_item_processed,
      );

      accumulate_drive_result(accumulators, delta_link_by_drive, drive, drive_result);

      // Saved even when items failed: the successful entries are real, and the
      // ledger riding along is what keeps the failures from being forgotten.
      await cursors.save(ctx, {
        owner_id,
        delta_link_by_drive,
        ...tracking_state,
        failed_items: accumulators.failed_items,
        updated_at: new Date().toISOString(),
      });
      report_drive_success(
        progress,
        index,
        delta.items.length === 0 && prev_delta !== undefined && drive_result.entries.length === 0,
        drive_result,
        version_stats.total_versions_stored - versions_before,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`Drive ${drive.drive_id} failed: ${reason}`);
      accumulators.errors.push(`Drive ${drive.drive_name} (${drive.drive_id}): ${reason}`);
      progress?.mark_error(index, reason);
    }
  }

  return accumulators;
}

/** Folds one drive's outcome into the run accumulators and the delta link map. */
function accumulate_drive_result(
  accumulators: DriveScanAccumulators,
  delta_link_by_drive: Record<string, string>,
  drive: OneDriveDrive,
  drive_result: SingleDriveResult,
): void {
  accumulators.entries.push(...drive_result.entries);
  accumulators.files_stored += drive_result.files_stored;
  accumulators.files_deduplicated += drive_result.files_deduplicated;
  accumulators.deleted_items += drive_result.deleted_items;
  accumulators.failed_items = drive_result.failed_items;

  if (drive_result.delta_link) {
    delta_link_by_drive[drive.drive_id] = drive_result.delta_link;
  }
  if (drive_result.errors.length > 0) {
    logger.warn(
      `Drive ${drive.drive_id}: ${drive_result.errors.length} item(s) failed; ` +
        `delta advanced and failures recorded for retry`,
    );
  }
}

/**
 * Processes delta changes for a single OneDrive drive.
 *
 * Outstanding failures are re-fetched and processed first, then the new delta
 * batch. A failing item never costs the run its successful entries or its delta
 * link -- it is recorded in the returned ledger and retried on the next run.
 */
export async function process_single_drive(
  connector: OneDriveConnector,
  file_indexes: OneDriveFileVersionIndexRepository,
  drive: OneDriveDrive,
  tenant_id: string,
  owner_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  state: DriveTrackingState,
  delta: OneDriveDeltaResult,
  failed_items: FailedItemLedger,
  version_stats: VersionStats,
  on_version_stats_update: (stored: number, unavailable: number, failed: number) => void,
  on_item_processed?: () => void,
): Promise<SingleDriveResult> {
  if (delta.reset_detected) {
    clear_file_tracking_on_reset(state);
  }

  const delta_item_ids = new Set(delta.items.map((item) => item.item_id));
  const retry = await resolve_retry_items(
    connector,
    tenant_id,
    owner_id,
    drive.drive_id,
    failed_items,
    delta_item_ids,
  );

  const queue: Array<{ item: OneDriveDeltaItem; from_delta: boolean }> = [
    ...retry.items.map((item) => ({ item, from_delta: false })),
    ...delta.items.map((item) => ({ item, from_delta: true })),
  ];

  const result: SingleDriveResult = {
    entries: [],
    files_stored: 0,
    files_deduplicated: 0,
    deleted_items: 0,
    delta_link: delta.delta_link,
    failed_items: retry.ledger,
    errors: [],
  };

  for (const { item, from_delta } of queue) {
    const outcome = await process_delta_item(
      connector,
      file_indexes,
      item,
      owner_id,
      snapshot_id,
      ctx,
      state,
      version_stats,
      on_version_stats_update,
    );
    // Progress rows were sized from the delta batch; retried items are extra.
    if (from_delta) on_item_processed?.();

    if (outcome.error) {
      logger.warn(`Drive ${drive.drive_id}: ${outcome.error}`);
      result.errors.push(outcome.error);
      result.failed_items = record_item_failure(result.failed_items, {
        item_id: item.item_id,
        drive_id: drive.drive_id,
        name: item.file_name,
        reason: outcome.error,
      });
      continue;
    }

    result.failed_items = clear_item_failure(result.failed_items, item.item_id);
    result.files_stored += outcome.files_stored;
    result.files_deduplicated += outcome.files_deduplicated;
    result.deleted_items += outcome.deleted_items;
    if (outcome.entry) result.entries.push(outcome.entry);
  }

  return result;
}
