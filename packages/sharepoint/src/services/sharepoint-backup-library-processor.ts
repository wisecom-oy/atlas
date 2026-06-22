import type {
  SharePointBackupOptions,
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  SharePointDeltaItem,
  SharePointDeltaResult,
  SharePointDocumentLibrary,
  SharePointFileVersionIndexRepository,
  SharePointManifestEntry,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  accumulate_version_stats,
  build_deleted_entry,
  build_stored_entry,
} from '@/services/sharepoint-backup-builders';
import { process_backup_file } from '@/services/sharepoint-backup-file-processor';
import { classify_change_type } from '@/services/sharepoint-change-classifier';
import { sync_file_versions } from '@/services/sharepoint-version-sync';

export interface FileTrackingState {
  previous_path_by_file_id: Record<string, string>;
  previous_name_by_file_id: Record<string, string>;
  previous_etag_by_file_id: Record<string, string>;
  previous_kind_by_file_id: Record<string, 'file' | 'folder'>;
}

export interface LibraryProcessingResult {
  entries: SharePointManifestEntry[];
  files_stored: number;
  files_deduplicated: number;
  deleted_items: number;
  delta_link?: string;
  had_errors: boolean;
}

export interface VersionStatsState {
  total_versions_stored: number;
  total_versions_unavailable: number;
  total_versions_failed: number;
}

/** Clears file tracking maps when Graph signals a delta reset. */
export function clear_file_tracking_on_reset(tracking: FileTrackingState): void {
  for (const [fid, kind] of Object.entries(tracking.previous_kind_by_file_id)) {
    if (kind === 'file') {
      delete tracking.previous_path_by_file_id[fid];
      delete tracking.previous_name_by_file_id[fid];
      delete tracking.previous_etag_by_file_id[fid];
    }
  }
}

/** Processes a single delta item and updates library and tracking state. */
export async function process_delta_item(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  snapshot_id: string,
  ctx: TenantContext,
  tracking: FileTrackingState,
  library_state: {
    library_has_errors: boolean;
    library_entries: SharePointManifestEntry[];
    library_files_stored: number;
    library_files_deduplicated: number;
    library_deleted_items: number;
  },
  file_indexes: SharePointFileVersionIndexRepository,
  version_stats: VersionStatsState,
  errors: string[],
): Promise<void> {
  const effective_kind =
    item.deleted && item.kind === 'file' && tracking.previous_kind_by_file_id[item.item_id]
      ? tracking.previous_kind_by_file_id[item.item_id]
      : item.kind;
  if (effective_kind !== 'file') {
    if (!item.deleted) tracking.previous_kind_by_file_id[item.item_id] = item.kind;
    return;
  }

  const change_type = classify_change_type(
    item,
    tracking.previous_path_by_file_id,
    tracking.previous_name_by_file_id,
    tracking.previous_etag_by_file_id,
  );
  if (!change_type) return;

  if (item.deleted) {
    library_state.library_deleted_items++;
    library_state.library_entries.push(build_deleted_entry(item, change_type));
    return;
  }

  const result = await process_backup_file(connector, item, site_id, ctx);
  if (!result) {
    library_state.library_has_errors = true;
    errors.push(`Failed to process file ${item.file_name} (${item.item_id})`);
    return;
  }

  if (result.deduplicated) library_state.library_files_deduplicated++;
  if (result.stored) library_state.library_files_stored++;

  if (!result.deduplicated) {
    const version_result = await sync_file_versions(
      connector,
      item,
      site_id,
      snapshot_id,
      ctx,
      file_indexes,
    );
    accumulate_version_stats(version_result, version_stats, (s, u, f) => {
      version_stats.total_versions_stored = s;
      version_stats.total_versions_unavailable = u;
      version_stats.total_versions_failed = f;
    });
  }

  library_state.library_entries.push(
    build_stored_entry(item, result.storage_key, result.checksum, change_type),
  );
  tracking.previous_path_by_file_id[item.item_id] = item.parent_path;
  tracking.previous_name_by_file_id[item.item_id] = item.file_name;
  tracking.previous_kind_by_file_id[item.item_id] = 'file';
  if (item.etag) tracking.previous_etag_by_file_id[item.item_id] = item.etag;
}

/** Processes one document library delta and persists cursor state on success. */
export async function process_single_library(
  connector: SharePointSiteConnector,
  cursors: SharePointDeltaCursorRepository,
  file_indexes: SharePointFileVersionIndexRepository,
  tenant_id: string,
  site_id: string,
  snapshot_id: string,
  library: SharePointDocumentLibrary,
  options: SharePointBackupOptions,
  previous_cursor: SharePointDeltaCursor | undefined,
  tracking: FileTrackingState,
  delta_link_by_drive: Record<string, string>,
  ctx: TenantContext,
  version_stats: VersionStatsState,
  errors: string[],
): Promise<LibraryProcessingResult> {
  const prev_delta =
    options.force_full === true
      ? undefined
      : previous_cursor?.delta_link_by_drive[library.drive_id];
  const delta: SharePointDeltaResult = await connector.fetch_delta(
    tenant_id,
    site_id,
    library.drive_id,
    prev_delta,
  );

  if (delta.reset_detected) {
    clear_file_tracking_on_reset(tracking);
  }

  const library_state = {
    library_has_errors: false,
    library_entries: [] as SharePointManifestEntry[],
    library_files_stored: 0,
    library_files_deduplicated: 0,
    library_deleted_items: 0,
  };

  for (const item of delta.items) {
    await process_delta_item(
      connector,
      item,
      site_id,
      snapshot_id,
      ctx,
      tracking,
      library_state,
      file_indexes,
      version_stats,
      errors,
    );
  }

  if (library_state.library_has_errors) {
    logger.warn(
      `Library ${library.drive_id}: discarding ${library_state.library_entries.length} entries due to errors`,
    );
    return {
      entries: [],
      files_stored: 0,
      files_deduplicated: 0,
      deleted_items: 0,
      had_errors: true,
    };
  }

  delta_link_by_drive[library.drive_id] = delta.delta_link;
  await cursors.save(ctx, {
    site_id,
    delta_link_by_drive,
    ...tracking,
    updated_at: new Date().toISOString(),
  });

  return {
    entries: library_state.library_entries,
    files_stored: library_state.library_files_stored,
    files_deduplicated: library_state.library_files_deduplicated,
    deleted_items: library_state.library_deleted_items,
    delta_link: delta.delta_link,
    had_errors: false,
  };
}
