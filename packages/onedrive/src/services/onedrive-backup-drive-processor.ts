import type {
  BackupProgressReporter,
  OneDriveConnector,
  OneDriveDeltaResult,
  OneDriveDrive,
  OneDriveDeltaCursorRepository,
  OneDriveFileVersionIndexRepository,
  OneDriveManifestEntry,
  TenantContext,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  summarize_package_items,
  type PackageReport,
} from '@wisecom/atlas-core/services/shared/package-item-reporter';
import {
  clear_file_tracking_on_reset,
  process_delta_item,
  type DriveTrackingState,
  type VersionStats,
} from '@/services/onedrive-delta-item-processor';
import {
  make_item_progress_callback,
  report_drive_success,
  type ScanProgressTotals,
} from '@/services/onedrive-scan-progress';

/** Package accounting summed across every drive in one run. */
export interface PackageReportTotals {
  notebooks_detected: number;
  section_files_backed_up: number;
  warnings: string[];
}

export interface SingleDriveResult {
  entries: OneDriveManifestEntry[];
  files_stored: number;
  files_deduplicated: number;
  deleted_items: number;
  success: boolean;
  delta_link?: string;
  errors: string[];
  package_report: PackageReport;
}

export interface DriveScanAccumulators {
  entries: OneDriveManifestEntry[];
  files_stored: number;
  files_deduplicated: number;
  deleted_items: number;
  errors: string[];
  package_report: PackageReportTotals;
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
  previous_cursor: { delta_link_by_drive: Record<string, string> } | undefined,
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
    errors: [],
    package_report: { notebooks_detected: 0, section_files_backed_up: 0, warnings: [] },
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
        version_stats,
        on_version_stats_update,
        on_item_processed,
      );

      // Notebook accounting stands apart from the entry discard below: a drive
      // that failed is exactly the one whose notebooks came through incomplete.
      accumulate_package_report(accumulators.package_report, drive_result.package_report);

      if (drive_result.success) {
        accumulators.entries.push(...drive_result.entries);
        accumulators.files_stored += drive_result.files_stored;
        accumulators.files_deduplicated += drive_result.files_deduplicated;
        accumulators.deleted_items += drive_result.deleted_items;
        if (drive_result.delta_link) {
          delta_link_by_drive[drive.drive_id] = drive_result.delta_link;
        }

        await cursors.save(ctx, {
          owner_id,
          delta_link_by_drive,
          ...tracking_state,
          updated_at: new Date().toISOString(),
        });
        report_drive_success(
          progress,
          index,
          delta.items.length === 0 && prev_delta !== undefined,
          drive_result,
          version_stats.total_versions_stored - versions_before,
        );
      } else {
        accumulators.errors.push(...drive_result.errors);
        progress?.mark_error(index, drive_result.errors[0] ?? 'drive failed');
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

/** Folds one drive's package report into the run-wide totals. */
function accumulate_package_report(totals: PackageReportTotals, report: PackageReport): void {
  totals.notebooks_detected += report.notebooks_detected;
  totals.section_files_backed_up += report.section_files_backed_up;
  totals.warnings.push(...report.warnings);
}

/** Processes delta changes for a single OneDrive drive. */
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
  version_stats: VersionStats,
  on_version_stats_update: (stored: number, unavailable: number, failed: number) => void,
  on_item_processed?: () => void,
): Promise<SingleDriveResult> {
  if (delta.reset_detected) {
    clear_file_tracking_on_reset(state);
  }

  const drive_entries: OneDriveManifestEntry[] = [];
  let drive_files_stored = 0;
  let drive_files_deduplicated = 0;
  let drive_deleted_items = 0;
  const item_errors: string[] = [];
  const failed_item_ids = new Set<string>();

  for (const item of delta.items) {
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
    on_item_processed?.();

    if (outcome.error) {
      item_errors.push(outcome.error);
      failed_item_ids.add(item.item_id);
      continue;
    }

    drive_files_stored += outcome.files_stored;
    drive_files_deduplicated += outcome.files_deduplicated;
    drive_deleted_items += outcome.deleted_items;
    if (outcome.entry) drive_entries.push(outcome.entry);
  }

  const package_report = summarize_package_items(delta.items, failed_item_ids);

  if (item_errors.length > 0) {
    logger.warn(
      `Drive ${drive.drive_id}: discarding ${drive_entries.length} entries due to errors`,
    );
    return {
      entries: [],
      files_stored: 0,
      files_deduplicated: 0,
      deleted_items: 0,
      success: false,
      errors: item_errors,
      package_report,
    };
  }

  return {
    entries: drive_entries,
    files_stored: drive_files_stored,
    files_deduplicated: drive_files_deduplicated,
    deleted_items: drive_deleted_items,
    success: true,
    delta_link: delta.delta_link,
    errors: [],
    package_report,
  };
}
