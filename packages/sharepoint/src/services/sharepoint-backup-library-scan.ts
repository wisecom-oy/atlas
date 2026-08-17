import { logger } from '@wisecom/atlas-core/utils/logger';
import type { FailedItemLedger } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { PackageReport } from '@wisecom/atlas-core/services/shared/package-item-reporter';
import type {
  SharePointBackupOptions,
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  SharePointDocumentLibrary,
  SharePointFileVersionIndexRepository,
  SharePointManifestEntry,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import { process_single_library } from '@/services/sharepoint-backup-library-processor';
import type {
  FileTrackingState,
  VersionStatsState,
} from '@/services/sharepoint-library-item-processor';

export interface SharePointLibraryScanResult {
  entries: SharePointManifestEntry[];
  files_stored: number;
  files_deduplicated: number;
  deleted_items: number;
  errors: string[];
  failed_items: FailedItemLedger;
  version_stats: VersionStatsState;
  package_reports: PackageReport[];
  libraries_scanned: number;
  interrupted: boolean;
}

interface SharePointLibraryScanParams {
  connector: SharePointSiteConnector;
  cursors: SharePointDeltaCursorRepository;
  file_indexes: SharePointFileVersionIndexRepository;
  tenant_id: string;
  site_id: string;
  snapshot_id: string;
  libraries: readonly SharePointDocumentLibrary[];
  options: SharePointBackupOptions;
  previous_cursor: SharePointDeltaCursor | undefined;
  tracking: FileTrackingState;
  delta_link_by_drive: Record<string, string>;
  ctx: TenantContext;
  initial_failed_items: FailedItemLedger;
}

/** Scans libraries sequentially and stops at a safe item boundary. */
export async function scan_all_libraries({
  connector,
  cursors,
  file_indexes,
  tenant_id,
  site_id,
  snapshot_id,
  libraries,
  options,
  previous_cursor,
  tracking,
  delta_link_by_drive,
  ctx,
  initial_failed_items,
}: SharePointLibraryScanParams): Promise<SharePointLibraryScanResult> {
  const result: SharePointLibraryScanResult = {
    entries: [],
    files_stored: 0,
    files_deduplicated: 0,
    deleted_items: 0,
    errors: [],
    failed_items: initial_failed_items,
    version_stats: {
      total_versions_stored: 0,
      total_versions_unavailable: 0,
      total_versions_failed: 0,
    },
    package_reports: [],
    libraries_scanned: 0,
    interrupted: false,
  };
  let processed = 0;

  for (const library of libraries) {
    if (options.should_interrupt?.() === true) {
      result.interrupted = true;
      break;
    }
    result.libraries_scanned++;
    try {
      const library_result = await process_single_library(
        connector,
        cursors,
        file_indexes,
        tenant_id,
        site_id,
        snapshot_id,
        library,
        options,
        previous_cursor,
        tracking,
        delta_link_by_drive,
        ctx,
        result.version_stats,
        result.failed_items,
        (file_name) => {
          processed++;
          options.on_progress?.({
            operation: 'backup',
            workload: 'sharepoint',
            phase: 'processing',
            processed,
            current: file_name,
          });
        },
      );

      result.failed_items = library_result.failed_items;
      result.package_reports.push(library_result.package_report);
      result.entries.push(...library_result.entries);
      result.files_stored += library_result.files_stored;
      result.files_deduplicated += library_result.files_deduplicated;
      result.deleted_items += library_result.deleted_items;
      if (library_result.interrupted) {
        result.interrupted = true;
        break;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`Library ${library.drive_id} failed: ${reason}`);
      result.errors.push(`Library ${library.drive_name} (${library.drive_id}): ${reason}`);
    }
  }

  return result;
}
