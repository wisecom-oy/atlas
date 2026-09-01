import type {
  SharePointBackupOptions,
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  SharePointDeltaResult,
  SharePointDocumentLibrary,
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
} from '@/services/backup/library-item-processor';
import type { RunVersionCollector } from '@/services/versioning/version-sync';
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
  interrupted: boolean;
  package_report: PackageReport;
}

/**
 * Forgets tracking for the files a reset re-enumerates, so they rebaseline as
 * `created`.
 *
 * Scoped to the ids the resetting delta returned rather than the whole map. The
 * maps are keyed by file id alone and shared by every library in the site, so
 * clearing all of them let one library's dead delta link wipe its siblings'
 * path, name and etag records. A genuine change in a sibling on a still-valid
 * link then looked like a first backup (issue #199).
 *
 * A reset delta is a full enumeration of that drive, so its ids are exactly the
 * entries that need forgetting. That holds for cursors written before this fix
 * too, which is why nothing has to be migrated.
 */
export function clear_file_tracking_on_reset(
  tracking: FileTrackingState,
  reset_item_ids: Iterable<string>,
): void {
  for (const fid of reset_item_ids) {
    if (tracking.previous_kind_by_file_id[fid] === 'file') {
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
  versions: RunVersionCollector,
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
  on_item_processed?: (file_name: string) => void,
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
    clear_file_tracking_on_reset(
      tracking,
      delta.items.map((item) => item.item_id),
    );
  }

  const library_state: LibraryProcessingState = {
    library_entries: [],
    library_name: library.drive_name,
    library_files_stored: 0,
    library_files_deduplicated: 0,
    library_deleted_items: 0,
    failed_items,
    failed_item_ids: new Set<string>(),
  };

  let interrupted = await retry_failed_items(
    connector,
    tenant_id,
    site_id,
    snapshot_id,
    library.drive_id,
    ctx,
    tracking,
    library_state,
    versions,
    version_stats,
    options.should_interrupt,
    on_item_processed,
  );

  let processed_delta_items = 0;
  for (const item of delta.items) {
    if (options.should_interrupt?.() === true) {
      interrupted = true;
      break;
    }
    await process_item_guarded(
      connector,
      item,
      site_id,
      snapshot_id,
      ctx,
      tracking,
      library_state,
      versions,
      version_stats,
    );
    processed_delta_items++;
    on_item_processed?.(item.file_name);
  }
  interrupted ||= options.should_interrupt?.() === true;

  const incomplete_item_ids = new Set(library_state.failed_item_ids);
  if (interrupted) {
    for (const item of delta.items.slice(processed_delta_items))
      incomplete_item_ids.add(item.item_id);
  }
  const package_report = summarize_package_items(delta.items, incomplete_item_ids);

  if (!interrupted) delta_link_by_drive[library.drive_id] = delta.delta_link;
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
    ...(interrupted ? {} : { delta_link: delta.delta_link }),
    interrupted,
    failed_items: library_state.failed_items,
    package_report,
  };
}
