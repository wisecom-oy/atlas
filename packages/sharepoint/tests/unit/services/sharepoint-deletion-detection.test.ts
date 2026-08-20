import { describe, it, expect, vi } from 'vitest';
import type {
  FailedItemLedger,
  SharePointDeltaItem,
  SharePointFileVersionIndexRepository,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  process_delta_item,
  type LibraryProcessingState,
} from '@/services/sharepoint-library-item-processor';
import type { FileTrackingState } from '@/services/sharepoint-file-tracking';

// Issue #139: removals arrive with the `deleted` facet, no name, and no download
// URL. They must produce a deleted entry, skip the download, and clear any
// ledger entry left behind while removals were being misread as failures.

const SITE_ID = 'site-1';
const SNAPSHOT_ID = 'sp-snap-test';

function make_tracking(overrides: Partial<FileTrackingState> = {}): FileTrackingState {
  return {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
    ...overrides,
  } as FileTrackingState;
}

function make_library_state(failed_items: FailedItemLedger = {}): LibraryProcessingState {
  return {
    library_entries: [],
    library_name: 'Documents',
    library_files_stored: 0,
    library_files_deduplicated: 0,
    library_deleted_items: 0,
    failed_items,
    failed_item_ids: new Set<string>(),
  };
}

function deleted_item(item_id: string): SharePointDeltaItem {
  return {
    item_id,
    drive_id: 'lib1',
    kind: 'file',
    file_name: '',
    parent_path: '/Shared Documents',
    size_bytes: 0,
    deleted: true,
  };
}

function make_ctx(): TenantContext {
  return {
    tenant_id: 't',
    storage: { exists: vi.fn().mockResolvedValue(false), put: vi.fn() },
    encrypt: (buffer: Buffer) => buffer,
  } as unknown as TenantContext;
}

describe('SharePoint deletion handling (issue #139)', () => {
  it('records a deleted entry named from the last known name, without downloading', async () => {
    const download = vi.fn();
    const connector = { download_file_content: download } as unknown as SharePointSiteConnector;
    const library_state = make_library_state();

    await process_delta_item(
      connector,
      deleted_item('i1'),
      SITE_ID,
      SNAPSHOT_ID,
      make_ctx(),
      make_tracking({
        previous_name_by_file_id: { i1: 'Budget.xlsx' },
        previous_path_by_file_id: { i1: '/Shared Documents' },
        previous_kind_by_file_id: { i1: 'file' },
      }),
      library_state,
      {} as SharePointFileVersionIndexRepository,
      { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    );

    expect(library_state.library_deleted_items).toBe(1);
    expect(library_state.library_entries).toHaveLength(1);
    expect(library_state.library_entries[0]?.file_name).toBe('Budget.xlsx');
    expect(library_state.library_entries[0]?.change_type).toBe('deleted');
    expect(library_state.library_entries[0]?.storage_key).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
  });

  it('clears a ledger entry left by a removal that used to be read as a failure', async () => {
    const connector = { download_file_content: vi.fn() } as unknown as SharePointSiteConnector;
    const poisoned: FailedItemLedger = {
      i1: {
        item_id: 'i1',
        drive_id: 'lib1',
        name: '',
        reason: 'file content could not be downloaded',
        attempts: 3,
        first_failed_at: '2026-08-01T00:00:00Z',
        last_failed_at: '2026-08-03T00:00:00Z',
      },
    };
    const library_state = make_library_state(poisoned);

    await process_delta_item(
      connector,
      deleted_item('i1'),
      SITE_ID,
      SNAPSHOT_ID,
      make_ctx(),
      make_tracking({
        previous_name_by_file_id: { i1: 'Report.docx' },
        previous_kind_by_file_id: { i1: 'file' },
      }),
      library_state,
      {} as SharePointFileVersionIndexRepository,
      { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    );

    expect(library_state.failed_items.i1).toBeUndefined();
    expect(library_state.failed_item_ids.has('i1')).toBe(false);
  });
});
