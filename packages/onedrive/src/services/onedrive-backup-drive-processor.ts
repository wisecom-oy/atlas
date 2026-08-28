import type {
  BackupProgressReporter,
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveDeltaResult,
  OneDriveDrive,
  OneDriveFileVersionRecord,
  OneDriveDeltaCursorRepository,
  OneDriveManifestEntry,
  TenantContext,
  OperationControlOptions,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import {
  clear_item_failure,
  record_item_failure,
  type FailedItemLedger,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { PackageReport } from '@wisecom/atlas-core/services/shared/package-item-reporter';
import {
  clear_file_tracking_on_reset,
  process_delta_item,
  type DriveTrackingState,
  type VersionStats,
} from '@/services/onedrive-delta-item-processor';
import { resolve_retry_items } from '@/services/onedrive-failed-item-retry';
import { scoped_delta } from '@/services/onedrive-folder-scope';
import { persist_scan_cursor } from '@/services/onedrive-scan-cursor-writer';
import type { RunVersionCollector } from '@/services/onedrive-version-sync';
import {
  make_item_progress_callback,
  report_drive_success,
  type ScanProgressTotals,
} from '@/services/onedrive-scan-progress';
import {
  accumulate_package_report,
  summarize_processed_package_items,
  type PackageReportTotals,
} from '@/services/onedrive-package-report';

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
  package_report: PackageReport;
  interrupted: boolean;
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
  drives_scanned: number;
  items_processed: number;
  interrupted: boolean;
  package_report: PackageReportTotals;
  /** Version rows captured during this run, per file id; written as one index object at finalize time. */
  version_rows: Map<string, OneDriveFileVersionRecord[]>;
}

/** Fetches delta changes across all drives and accumulates manifest entries. */
export async function scan_all_drives(
  connector: OneDriveConnector,
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
  versions: RunVersionCollector,
  version_stats: VersionStats,
  on_version_stats_update: (stored: number, unavailable: number, failed: number) => void,
  progress?: BackupProgressReporter,
  control: OperationControlOptions = {},
  folder_scope?: string,
): Promise<DriveScanAccumulators> {
  // No index read here: version dedup rides on the delta cursor watermarks the
  // caller already loaded (issue #161).
  const accumulators: DriveScanAccumulators = {
    entries: [],
    files_stored: 0,
    files_deduplicated: 0,
    deleted_items: 0,
    failed_items: { ...(previous_cursor?.failed_items ?? {}) },
    errors: [],
    drives_scanned: 0,
    items_processed: 0,
    interrupted: false,
    package_report: { notebooks_detected: 0, section_files_backed_up: 0, warnings: [] },
    version_rows: versions.rows,
  };

  const totals: ScanProgressTotals = { processed: 0, total: 0, started_at: Date.now() };

  for (const [index, drive] of drives.entries()) {
    if (control.should_interrupt?.() === true) {
      accumulators.interrupted = true;
      progress?.mark_all_pending_interrupted();
      break;
    }
    try {
      const prev_delta = force_full
        ? undefined
        : previous_cursor?.delta_link_by_drive[drive.drive_id];
      progress?.update_paging(index, 0, 0, 0);
      // Scoping filters the delta result rather than the query, because Graph's driveItem delta is
      // drive-wide. Enumeration still pages the whole drive; nothing outside the scope is
      // downloaded, hashed, version-synced or written, which is where the time goes.
      const delta = scoped_delta(
        await connector.fetch_delta(tenant_id, owner_id, drive.drive_id, prev_delta),
        folder_scope,
        tracking_state.previous_path_by_file_id,
      );
      progress?.set_row_total?.(index, delta.items.length);
      totals.total += delta.items.length;
      progress?.mark_active(index);

      const versions_before = version_stats.total_versions_stored;
      const update_item_progress = make_item_progress_callback(progress, index, totals);
      const on_item_processed = (item: OneDriveDeltaItem): void => {
        update_item_progress();
        accumulators.items_processed = totals.processed;
        emit_operation_progress(control, {
          operation: 'backup',
          workload: 'onedrive',
          phase: 'processing',
          processed: totals.processed,
          total: totals.total,
          current: item.file_name,
        });
      };

      const drive_result = await process_single_drive(
        connector,
        versions,
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
        control,
      );

      // Notebook accounting stands apart from the entry bookkeeping: a drive
      // whose items failed is exactly the one whose notebooks came through
      // incomplete, so it is folded in for every drive, failed or not.
      accumulate_package_report(accumulators.package_report, drive_result.package_report);
      accumulate_drive_result(accumulators, delta_link_by_drive, drive, drive_result);
      accumulators.drives_scanned++;

      await persist_scan_cursor(
        cursors,
        ctx,
        owner_id,
        delta_link_by_drive,
        tracking_state,
        accumulators.failed_items,
        folder_scope,
      );
      if (!drive_result.interrupted) {
        report_drive_success(
          progress,
          index,
          delta.items.length === 0 && prev_delta !== undefined && drive_result.entries.length === 0,
          drive_result,
          version_stats.total_versions_stored - versions_before,
        );
      }
      if (drive_result.interrupted || control.should_interrupt?.() === true) {
        accumulators.interrupted = true;
        progress?.mark_all_pending_interrupted();
        break;
      }
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
  accumulators.interrupted ||= drive_result.interrupted;

  if (!drive_result.interrupted && drive_result.delta_link) {
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
  versions: RunVersionCollector,
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
  on_item_processed?: (item: OneDriveDeltaItem) => void,
  control: OperationControlOptions = {},
): Promise<SingleDriveResult> {
  const delta_item_ids = new Set(delta.items.map((item) => item.item_id));
  if (delta.reset_detected) {
    clear_file_tracking_on_reset(state, delta_item_ids);
  }

  const retry = await resolve_retry_items(
    connector,
    tenant_id,
    owner_id,
    drive.drive_id,
    failed_items,
    delta_item_ids,
    control.should_interrupt,
  );
  // Ids that failed in THIS run drive notebook completeness; the ledger also
  // carries older failures, which say nothing about this batch.
  const failed_item_ids = new Set<string>();
  const processed_delta_item_ids = new Set<string>();

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
    interrupted: retry.interrupted,
    errors: [],
    // Replaced once every item in this batch has been processed.
    package_report: { notebooks_detected: 0, section_files_backed_up: 0, warnings: [] },
  };

  for (const { item, from_delta } of queue) {
    if (result.interrupted || control.should_interrupt?.() === true) {
      result.interrupted = true;
      delete result.delta_link;
      break;
    }
    const outcome = await process_delta_item(
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      state,
      version_stats,
      on_version_stats_update,
      versions,
    );
    // Progress rows were sized from the delta batch; retried items are extra.
    if (from_delta) on_item_processed?.(item);
    if (from_delta) processed_delta_item_ids.add(item.item_id);

    if (outcome.error) {
      logger.warn(`Drive ${drive.drive_id}: ${outcome.error}`);
      result.errors.push(outcome.error);
      failed_item_ids.add(item.item_id);
      result.failed_items = record_item_failure(result.failed_items, {
        item_id: item.item_id,
        drive_id: drive.drive_id,
        name: item.file_name,
        reason: outcome.error,
        ...(outcome.permanent === true ? { permanent: true } : {}),
      });
      continue;
    }

    result.failed_items = clear_item_failure(result.failed_items, item.item_id);
    result.files_stored += outcome.files_stored;
    result.files_deduplicated += outcome.files_deduplicated;
    result.deleted_items += outcome.deleted_items;
    if (outcome.entry) result.entries.push(outcome.entry);
  }

  result.package_report = summarize_processed_package_items(
    delta.items,
    failed_item_ids,
    processed_delta_item_ids,
    result.interrupted,
  );
  return result;
}
