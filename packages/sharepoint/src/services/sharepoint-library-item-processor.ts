import type {
  SharePointDeltaItem,
  SharePointManifestEntry,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  clear_item_failure,
  record_item_failure,
  retryable_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { FailedItemLedger } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import {
  accumulate_version_stats,
  build_deleted_entry,
  build_stored_entry,
} from '@/services/sharepoint-backup-builders';
import { process_backup_file } from '@/services/sharepoint-backup-file-processor';
import { classify_change_type } from '@/services/sharepoint-change-classifier';
import {
  collect_run_versions,
  sync_file_versions,
  type RunVersionCollector,
} from '@/services/sharepoint-version-sync';

export interface FileTrackingState {
  previous_path_by_file_id: Record<string, string>;
  previous_name_by_file_id: Record<string, string>;
  previous_etag_by_file_id: Record<string, string>;
  previous_kind_by_file_id: Record<string, 'file' | 'folder'>;
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
    // Graph omits `name` for a removed item, so the last name we saw is the
    // only one there is (issue #139).
    const file_name = item.file_name || (tracking.previous_name_by_file_id[item.item_id] ?? '');
    library_state.library_deleted_items++;
    library_state.library_entries.push(
      build_deleted_entry({ ...item, file_name }, change_type, library_state.library_name),
    );
    library_state.failed_items = clear_item_failure(library_state.failed_items, item.item_id);
    return;
  }

  const result = await process_backup_file(connector, item, site_id, ctx);
  if (!result) {
    library_state.failed_item_ids.add(item.item_id);
    library_state.failed_items = record_item_failure(library_state.failed_items, {
      item_id: item.item_id,
      drive_id: item.drive_id,
      name: item.file_name,
      reason: 'file content could not be downloaded',
    });
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
      versions.watermarks[item.item_id],
    );
    collect_run_versions(versions, item.item_id, version_result);
    accumulate_version_stats(version_result, version_stats, (s, u, f) => {
      version_stats.total_versions_stored = s;
      version_stats.total_versions_unavailable = u;
      version_stats.total_versions_failed = f;
    });
  }
  library_state.library_entries.push(
    build_stored_entry(
      item,
      result.storage_key,
      result.checksum,
      change_type,
      library_state.library_name,
    ),
  );
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
    );
  } catch (err) {
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
  on_item_processed?: (file_name: string) => void,
): Promise<boolean> {
  for (const record of retryable_items(library_state.failed_items, drive_id)) {
    if (should_interrupt?.() === true) return true;
    const item = await connector.fetch_item_by_id(tenant_id, site_id, drive_id, record.item_id);

    if (!item) {
      logger.info(`Failed item ${record.item_id} (${record.name}) no longer exists -- clearing`);
      library_state.failed_items = clear_item_failure(library_state.failed_items, record.item_id);
      on_item_processed?.(record.name);
      continue;
    }

    // No successful backup of this item exists, so treat it as new content
    // regardless of stale tracking state: an unchanged etag would otherwise
    // classify as "no change" and leave the item stuck in the ledger.
    forget_item_tracking(tracking, record.item_id);
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
    on_item_processed?.(item.file_name);
  }
  return false;
}

/** Drops tracking state for one item so it is reprocessed as new content. */
function forget_item_tracking(tracking: FileTrackingState, item_id: string): void {
  delete tracking.previous_path_by_file_id[item_id];
  delete tracking.previous_name_by_file_id[item_id];
  delete tracking.previous_etag_by_file_id[item_id];
}
