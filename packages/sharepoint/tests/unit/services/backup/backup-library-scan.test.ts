import { describe, it, expect, vi } from 'vitest';
import type {
  SharePointBackupOptions,
  SharePointDocumentLibrary,
  SharePointManifestEntry,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import type { FailedItemLedger } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { scan_all_libraries } from '@/services/backup/backup-library-scan';
import { process_single_library } from '@/services/backup/backup-library-processor';
import type { LibraryProcessingResult } from '@/services/backup/backup-library-processor';
import type { FileTrackingState } from '@/services/backup/library-item-processor';
import type { RunVersionCollector } from '@/services/versioning/version-sync';

vi.mock('@/services/backup/backup-library-processor', () => ({
  process_single_library: vi.fn(),
}));

/**
 * Issue #626. `push(...library_result.entries)` passes every entry as a call argument and throws
 * `RangeError` past V8's argument limit (about 125k on Node 22). The library loop caught it as a
 * library failure, so a large library was reported failed and its entries were dropped.
 */
const BEYOND_ARGUMENT_LIMIT = 300_000;

function make_entry(i: number): SharePointManifestEntry {
  return { file_id: `f-${i}`, drive_id: 'lib-1' } as SharePointManifestEntry;
}

function library_result(entries: SharePointManifestEntry[]): LibraryProcessingResult {
  return {
    entries,
    files_stored: entries.length,
    files_deduplicated: 0,
    deleted_items: 0,
    failed_items: {} as FailedItemLedger,
    interrupted: false,
    package_report: { notebooks_detected: 0, section_files_backed_up: 0, warnings: [] },
    recrawl: undefined,
  };
}

describe('scan_all_libraries', () => {
  it('keeps every entry of a library larger than the engine argument limit', async () => {
    const entries = Array.from({ length: BEYOND_ARGUMENT_LIMIT }, (_, i) => make_entry(i));
    vi.mocked(process_single_library).mockResolvedValue(library_result(entries));

    const result = await scan_all_libraries({
      connector: {} as SharePointSiteConnector,
      versions: { rows: new Map(), watermarks: {} } as unknown as RunVersionCollector,
      tenant_id: 't',
      site_id: 'site-1',
      snapshot_id: 'snap-1',
      libraries: [{ drive_id: 'lib-1', drive_name: 'Documents' } as SharePointDocumentLibrary],
      options: {} as SharePointBackupOptions,
      previous_cursor: undefined,
      tracking: {} as FileTrackingState,
      delta_link_by_drive: {},
      ctx: {} as TenantContext,
      initial_failed_items: {} as FailedItemLedger,
    });

    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(BEYOND_ARGUMENT_LIMIT);
    expect(result.files_stored).toBe(BEYOND_ARGUMENT_LIMIT);
  });
});
