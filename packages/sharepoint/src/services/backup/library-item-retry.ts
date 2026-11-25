import type {
  SharePointDeltaItem,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import { AuthError } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  clear_item_failure,
  record_item_failure,
  retryable_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { is_transient_drive_failure } from '@wisecom/atlas-drive/backup/transient-download-failure';
import type { DriveItemMetadataCapture } from '@wisecom/atlas-drive/backup/item-metadata-capture';
import {
  process_item_guarded,
  type FileTrackingState,
  type LibraryProcessingState,
  type ProcessedItemRef,
  type VersionStatsState,
} from '@/services/backup/library-item-processor';
import type { RunVersionCollector } from '@/services/versioning/version-sync';

/**
 * Re-fetches items this drive failed on previously, before new delta changes.
 * Delta never re-presents an unchanged item, so the ledger is their only
 * second chance; items past the retry budget are reported but not re-fetched.
 */
export async function retry_failed_items(
  connector: SharePointSiteConnector,
  tenant_id: string,
  site_id: string,
  snapshot_id: string,
  drive_id: string,
  ctx: TenantContext,
  tracking: FileTrackingState,
  library_state: LibraryProcessingState,
  versions: RunVersionCollector,
  version_stats: VersionStatsState,
  should_interrupt?: () => boolean,
  on_item_processed?: (item: ProcessedItemRef) => void,
  abort_signal?: AbortSignal,
  capture?: DriveItemMetadataCapture,
): Promise<boolean> {
  for (const record of retryable_items(library_state.failed_items, drive_id)) {
    if (should_interrupt?.() === true) return true;
    const item = await refetch_or_record(
      connector,
      tenant_id,
      site_id,
      drive_id,
      record,
      library_state,
    );

    if (!item) {
      on_item_processed?.({ file_name: record.name, kind: 'file' });
      continue;
    }

    // No successful backup of this item exists, so treat it as new content
    // regardless of stale tracking state: an unchanged etag would otherwise
    // classify as "no change" and leave the item stuck in the ledger.
    forget_item_tracking(tracking, record.item_id);
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
        abort_signal,
        capture,
      );
    } catch (err) {
      // Cancelled mid-retry: the item keeps the attempt count it already had, and the caller
      // treats the library as interrupted (issue #344).
      if (abort_signal?.aborted !== true) throw err;
      return true;
    }
    on_item_processed?.(item);
  }
  return false;
}

/**
 * Re-reads one ledger item, turning a fetch failure into another ledger entry. A failure outside
 * the file, such as an outage or throttling, spends none of its attempts (issue #857).
 *
 * Unguarded, the throw travelled out of the library processor into the library scan, which
 * recorded a library-level error and dropped every entry the same run had already processed. One
 * flaky fetch cost the whole library its run. The OneDrive twin has always caught it per item
 * (issue #371). A revoked permission is not per-item and still propagates.
 *
 * Returns undefined when the item is gone or could not be read, in both cases having updated the
 * ledger itself.
 */
async function refetch_or_record(
  connector: SharePointSiteConnector,
  tenant_id: string,
  site_id: string,
  drive_id: string,
  record: { item_id: string; name: string },
  library_state: LibraryProcessingState,
): Promise<SharePointDeltaItem | undefined> {
  try {
    const item = await connector.fetch_item_by_id(tenant_id, site_id, drive_id, record.item_id);
    if (item) return item;
    logger.info(`Failed item ${record.item_id} (${record.name}) no longer exists -- clearing`);
    library_state.failed_items = clear_item_failure(library_state.failed_items, record.item_id);
    return undefined;
  } catch (err) {
    // A fetch cut short by cancellation keeps the attempt count the item already had; the library
    // scan treats the throw as the run stopping (issue #673).
    if (err instanceof AuthError || is_active_run_cancelled()) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    library_state.failed_items = record_item_failure(library_state.failed_items, {
      item_id: record.item_id,
      drive_id,
      name: record.name,
      reason: `Retry fetch failed: ${reason}`,
      // An outage or throttling says nothing about the file, so it keeps its attempts (#857).
      consumes_attempt: !is_transient_drive_failure(err),
    });
    return undefined;
  }
}

/** Drops tracking state for one item so it is reprocessed as new content. */
function forget_item_tracking(tracking: FileTrackingState, item_id: string): void {
  delete tracking.previous_path_by_file_id[item_id];
  delete tracking.previous_name_by_file_id[item_id];
  delete tracking.previous_etag_by_file_id[item_id];
}
