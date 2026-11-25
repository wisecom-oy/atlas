import type {
  SharePointBackupOptions,
  SharePointDeltaCursor,
  SharePointDeltaResult,
  SharePointDocumentLibrary,
  SharePointManifestEntry,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import type { FailedItemLedger } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { retry_failed_items } from '@/services/backup/library-item-retry';
import {
  process_item_guarded,
  type FileTrackingState,
  type LibraryProcessingState,
  type ProcessedItemRef,
  type VersionStatsState,
} from '@/services/backup/library-item-processor';
import type { RunVersionCollector } from '@/services/versioning/version-sync';
import {
  summarize_package_items,
  type PackageReport,
} from '@wisecom/atlas-core/services/shared/package-item-reporter';
import {
  completed_recrawl,
  type DriveRecrawl,
} from '@wisecom/atlas-drive/backup/recrawl-tombstones';
import { permission_digests } from '@wisecom/atlas-drive/backup/sharing-capture';
import { assert_delta_listing_complete } from '@wisecom/atlas-drive/backup/delta-listing-end';
import {
  create_item_metadata_capture,
  type DriveItemMetadataCapture,
} from '@wisecom/atlas-drive/backup/item-metadata-capture';

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
  /** Set when this library's full enumeration finished, for the re-crawl tombstones (issue #435). */
  recrawl: DriveRecrawl | undefined;
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
  const digests = permission_digests(tracking);
  for (const fid of reset_item_ids) {
    delete digests[fid];
    if (tracking.previous_kind_by_file_id[fid] === 'file') {
      delete tracking.previous_path_by_file_id[fid];
      delete tracking.previous_name_by_file_id[fid];
      delete tracking.previous_etag_by_file_id[fid];
    }
  }
}

/**
 * Processes one document library delta and accumulates its manifest entries.
 *
 * The delta link advances even when individual items fail: successful entries are kept and each
 * failure is recorded in the ledger for retry on the next run, so a single unreadable file can no
 * longer freeze the library's incrementals.
 *
 * Nothing is committed here. The advanced link rides in `delta_link_by_drive` until the caller has
 * written the snapshot manifest, because a cursor saved first would point past content no snapshot
 * references, and the next run would see no work to redo (issue #339).
 */
export async function process_single_library(
  connector: SharePointSiteConnector,
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
  on_item_processed?: (item: ProcessedItemRef) => void,
  capture: DriveItemMetadataCapture = create_item_metadata_capture(connector),
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
  // Before any tracking is touched: a library that throws here keeps its previous checkpoint.
  assert_delta_listing_complete(delta, `library ${library.drive_id}`);

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
    options.abort_signal,
    capture,
  );

  // `$batch` reads of 20 shared items or folders, ahead of the loop that would read them one by one.
  await capture.prefetch(library.drive_id, delta.items, tracking);
  let processed_delta_items = 0;
  for (const item of delta.items) {
    if (options.should_interrupt?.() === true) {
      interrupted = true;
      break;
    }
    try {
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
        options.abort_signal,
        capture,
      );
    } catch (err) {
      // The guard records a failed item and carries on, except for a cancelled transfer, which it
      // rethrows: the run is stopping, and this item has not failed (issue #344).
      if (options.abort_signal?.aborted !== true) throw err;
      interrupted = true;
      break;
    }
    processed_delta_items++;
    on_item_processed?.(item);
  }
  interrupted ||= options.should_interrupt?.() === true;

  const incomplete_item_ids = new Set(library_state.failed_item_ids);
  if (interrupted) {
    for (const item of delta.items.slice(processed_delta_items))
      incomplete_item_ids.add(item.item_id);
  }
  const package_report = summarize_package_items(delta.items, incomplete_item_ids);

  if (!interrupted) delta_link_by_drive[library.drive_id] = delta.delta_link;

  return {
    entries: library_state.library_entries,
    files_stored: library_state.library_files_stored,
    files_deduplicated: library_state.library_files_deduplicated,
    deleted_items: library_state.library_deleted_items,
    ...(interrupted ? {} : { delta_link: delta.delta_link }),
    recrawl: completed_recrawl(library.drive_id, delta, prev_delta, interrupted),
    interrupted,
    failed_items: library_state.failed_items,
    package_report,
  };
}
