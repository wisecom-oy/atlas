import type {
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
  accumulate_version_stats,
  build_deleted_entry,
  build_stored_entry,
} from '@/services/onedrive-backup-builders';
import { process_backup_file } from '@/services/onedrive-backup-file-processor';
import { classify_change_type } from '@/services/onedrive-change-classifier';
import { sync_file_versions } from '@/services/onedrive-version-sync';

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

export interface SingleDriveResult {
  entries: OneDriveManifestEntry[];
  files_stored: number;
  files_deduplicated: number;
  deleted_items: number;
  success: boolean;
  delta_link?: string;
  errors: string[];
}

/** Clears file tracking maps when Graph signals a delta reset. */
export function clear_file_tracking_on_reset(state: DriveTrackingState): void {
  for (const [fid, kind] of Object.entries(state.previous_kind_by_file_id)) {
    if (kind === 'file') {
      delete state.previous_path_by_file_id[fid];
      delete state.previous_name_by_file_id[fid];
      delete state.previous_etag_by_file_id[fid];
    }
  }
}

interface DeltaItemOutcome {
  entry?: OneDriveManifestEntry;
  files_stored: number;
  files_deduplicated: number;
  deleted_items: number;
  error?: string;
}

/** Processes one delta item and returns manifest entries or errors. */
export async function process_delta_item(
  connector: OneDriveConnector,
  file_indexes: OneDriveFileVersionIndexRepository,
  item: OneDriveDeltaItem,
  owner_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  state: DriveTrackingState,
  version_stats: VersionStats,
  on_version_stats_update: (stored: number, unavailable: number, failed: number) => void,
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
    return {
      entry: build_deleted_entry(item, change_type),
      files_stored: 0,
      files_deduplicated: 0,
      deleted_items: 1,
    };
  }

  const result = await process_backup_file(connector, item, owner_id, ctx);
  if (!result) {
    return {
      files_stored: 0,
      files_deduplicated: 0,
      deleted_items: 0,
      error: `Failed to process file ${item.file_name} (${item.item_id})`,
    };
  }

  if (!result.deduplicated) {
    const version_result = await sync_file_versions(
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      file_indexes,
    );
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

export interface DriveScanAccumulators {
  entries: OneDriveManifestEntry[];
  files_stored: number;
  files_deduplicated: number;
  deleted_items: number;
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
  previous_cursor: { delta_link_by_drive: Record<string, string> } | undefined,
  force_full: boolean,
  version_stats: VersionStats,
  on_version_stats_update: (stored: number, unavailable: number, failed: number) => void,
): Promise<DriveScanAccumulators> {
  const accumulators: DriveScanAccumulators = {
    entries: [],
    files_stored: 0,
    files_deduplicated: 0,
    deleted_items: 0,
    errors: [],
  };

  for (const drive of drives) {
    try {
      const prev_delta = force_full
        ? undefined
        : previous_cursor?.delta_link_by_drive[drive.drive_id];
      const delta = await connector.fetch_delta(tenant_id, owner_id, drive.drive_id, prev_delta);

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
      );

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
      } else {
        accumulators.errors.push(...drive_result.errors);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`Drive ${drive.drive_id} failed: ${reason}`);
      accumulators.errors.push(`Drive ${drive.drive_name} (${drive.drive_id}): ${reason}`);
    }
  }

  return accumulators;
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
): Promise<SingleDriveResult> {
  if (delta.reset_detected) {
    clear_file_tracking_on_reset(state);
  }

  const drive_entries: OneDriveManifestEntry[] = [];
  let drive_files_stored = 0;
  let drive_files_deduplicated = 0;
  let drive_deleted_items = 0;
  const item_errors: string[] = [];

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

    if (outcome.error) {
      item_errors.push(outcome.error);
      continue;
    }

    drive_files_stored += outcome.files_stored;
    drive_files_deduplicated += outcome.files_deduplicated;
    drive_deleted_items += outcome.deleted_items;
    if (outcome.entry) drive_entries.push(outcome.entry);
  }

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
  };
}
