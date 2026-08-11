import type {
  SharePointBackupOptions,
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  SharePointDeltaResult,
  SharePointDocumentLibrary,
  SharePointFileVersionIndexRepository,
  SharePointManifestEntry,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import type { FailedItemLedger } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import {
  process_item_guarded,
  retry_failed_items,
  type FileTrackingState,
  type LibraryProcessingState,
  type VersionStatsState,
} from '@/services/sharepoint-library-item-processor';
import {
  summarize_package_items,
  type PackageReport,
} from '@wisecom/atlas-core/services/shared/package-item-reporter';

export interface LibraryProcessingResult {
  entries: SharePointManifestEntry[];
  files_stored: number;
  files_deduplicated: number;
  deleted_items: number;
  delta_link?: string;
  /** Site-wide ledger after this library's retries and new failures. */
  failed_items: FailedItemLedger;
  package_report: PackageReport;
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

/**
 * Processes one document library delta and persists cursor state.
 *
 * The cursor advances even when individual items fail: successful entries are
 * kept and each failure is recorded in the ledger for retry on the next run,
 * so a single unreadable file can no longer freeze the library's incrementals.
 */
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
  failed_items: FailedItemLedger,
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

  const library_state: LibraryProcessingState = {
    library_entries: [],
    library_files_stored: 0,
    library_files_deduplicated: 0,
    library_deleted_items: 0,
    failed_items,
    failed_item_ids: new Set<string>(),
  };

  await retry_failed_items(
    connector,
    tenant_id,
    site_id,
    snapshot_id,
    library.drive_id,
    ctx,
    tracking,
    library_state,
    file_indexes,
    version_stats,
  );

  for (const item of delta.items) {
    await process_item_guarded(
      connector,
      item,
      site_id,
      snapshot_id,
      ctx,
      tracking,
      library_state,
      file_indexes,
      version_stats,
    );
  }

  const package_report = summarize_package_items(delta.items, library_state.failed_item_ids);

  delta_link_by_drive[library.drive_id] = delta.delta_link;
  await cursors.save(ctx, {
    site_id,
    delta_link_by_drive,
    ...tracking,
    failed_items: library_state.failed_items,
    updated_at: new Date().toISOString(),
  });

  return {
    entries: library_state.library_entries,
    files_stored: library_state.library_files_stored,
    files_deduplicated: library_state.library_files_deduplicated,
    deleted_items: library_state.library_deleted_items,
    delta_link: delta.delta_link,
    failed_items: library_state.failed_items,
    package_report,
  };
}
