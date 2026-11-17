import { describe, it, expect, vi } from 'vitest';
import type {
  SharePointDeltaItem,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { assert_transferred_size } from '@wisecom/atlas-drive/backup/download-integrity';
import {
  process_delta_item,
  type FileTrackingState,
  type LibraryProcessingState,
  type VersionStatsState,
} from '@/services/backup/library-item-processor';
import type { RunVersionCollector } from '@/services/versioning/version-sync';

// Issue #759: SharePoint rewrote the file on its first download. The entry must record the size
// that was stored, and the run must not ledger the item as a failure.

const LISTED = 145_408;
const SERVED = 151_040;

function make_item(): SharePointDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    kind: 'file',
    file_name: 'Message.msg',
    parent_path: '/',
    size_bytes: LISTED,
    deleted: false,
    etag: 'etag-1',
    download_url: 'https://cdn.example.invalid/listed',
  };
}

function run_with_growing_file() {
  // The first download returns the grown file; the item read then reports the grown size.
  const connector = {
    download_file_content: vi.fn(async (item: SharePointDeltaItem) => {
      const body = Buffer.alloc(SERVED, 'x');
      assert_transferred_size(item.item_id, body.length, item.size_bytes);
      return body;
    }),
    fetch_item_by_id: vi.fn(async () => ({
      ...make_item(),
      size_bytes: SERVED,
      download_url: 'https://cdn.example.invalid/fresh',
    })),
    list_file_versions: vi.fn(async () => []),
    resolve_download_url: vi.fn(async () => undefined),
  } as unknown as SharePointSiteConnector;
  const ctx = {
    tenant_id: 'tenant-1',
    storage: { exists: vi.fn(async () => false), put: vi.fn(async () => undefined) },
    encrypt: (buffer: Buffer) => buffer,
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
  const tracking: FileTrackingState = {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
  };
  const library_state: LibraryProcessingState = {
    library_entries: [],
    library_name: 'Documents',
    library_files_stored: 0,
    library_files_deduplicated: 0,
    library_deleted_items: 0,
    failed_items: {},
    failed_item_ids: new Set<string>(),
  };
  const versions: RunVersionCollector = { watermarks: {}, rows: new Map() };
  const version_stats: VersionStatsState = {
    total_versions_stored: 0,
    total_versions_unavailable: 0,
    total_versions_failed: 0,
  };
  return {
    connector,
    library_state,
    promise: process_delta_item(
      connector,
      make_item(),
      'site-1',
      'snap-1',
      ctx,
      tracking,
      library_state,
      versions,
      version_stats,
    ),
  };
}

describe('SharePoint file that grows on its first download (issue #759)', () => {
  it('records the stored size in the manifest entry and ledgers nothing', async () => {
    const { connector, library_state, promise } = run_with_growing_file();
    await promise;

    expect(connector.fetch_item_by_id).toHaveBeenCalledWith(
      'tenant-1',
      'site-1',
      'drive-1',
      'item-1',
    );
    expect(library_state.library_entries).toHaveLength(1);
    expect(library_state.library_entries[0]?.size_bytes).toBe(SERVED);
    expect(library_state.failed_items).toEqual({});
    expect(library_state.failed_item_ids.size).toBe(0);
  });
});
