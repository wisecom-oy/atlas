/**
 * Issue #53: a malware-quarantined file must not stall the backup.
 *
 * Graph never serves quarantined content, and it refuses in a way that looks
 * retryable: the transfer aborts rather than returning a clean 403, so
 * `is_network_error` matches on the message and `with_graph_retry` spends its
 * full ~23 minute budget on content that will never arrive. The pipeline
 * therefore has to skip the item on the `malware` facet, before any download.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import type {
  SharePointDeltaItem,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  process_delta_item,
  type FileTrackingState,
  type LibraryProcessingState,
  type VersionStatsState,
} from '@/services/sharepoint-library-item-processor';
import type { RunVersionCollector } from '@/services/sharepoint-version-sync';

function make_item(overrides: Partial<SharePointDeltaItem> = {}): SharePointDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    kind: 'file',
    file_name: 'infected.docx',
    parent_path: '/',
    size_bytes: 68,
    deleted: false,
    etag: 'etag-1',
    ...overrides,
  };
}

function make_tracking(): FileTrackingState {
  return {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
  };
}

function make_library_state(): LibraryProcessingState {
  return {
    library_entries: [],
    library_name: 'Documents',
    library_files_stored: 0,
    library_files_deduplicated: 0,
    library_deleted_items: 0,
    failed_items: {},
    failed_item_ids: new Set<string>(),
  };
}

function make_connector(): { connector: SharePointSiteConnector; download: Mock } {
  const download = vi.fn(async () => Buffer.from('content'));
  const connector = {
    download_file_content: download,
    list_file_versions: vi.fn(async () => []),
  } as unknown as SharePointSiteConnector;
  return { connector, download };
}

function make_context(): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      exists: vi.fn(async () => false),
      put: vi.fn(async () => undefined),
    },
    encrypt: (buffer: Buffer) => buffer,
  } as unknown as TenantContext;
}

async function run(item: SharePointDeltaItem) {
  const { connector, download } = make_connector();
  const library_state = make_library_state();
  const versions: RunVersionCollector = { watermarks: {}, rows: new Map() };
  const version_stats: VersionStatsState = {
    total_versions_stored: 0,
    total_versions_unavailable: 0,
    total_versions_failed: 0,
  };

  await process_delta_item(
    connector,
    item,
    'site-1',
    'snap-1',
    make_context(),
    make_tracking(),
    library_state,
    versions,
    version_stats,
  );

  return { library_state, download };
}

describe('process_delta_item with a quarantined file (#53)', () => {
  it('never attempts the download', async () => {
    const { download } = await run(make_item({ quarantined: true }));

    expect(download).not.toHaveBeenCalled();
  });

  it('records the block as permanent so later runs stop re-fetching it', async () => {
    const { library_state } = await run(make_item({ quarantined: true }));

    const record = library_state.failed_items['item-1'];
    expect(record?.permanent).toBe(true);
    expect(record?.reason).toContain('Quarantined');
    expect(library_state.failed_item_ids.has('item-1')).toBe(true);
  });

  it('stores no entry and counts no file', async () => {
    const { library_state } = await run(make_item({ quarantined: true }));

    expect(library_state.library_entries).toEqual([]);
    expect(library_state.library_files_stored).toBe(0);
    expect(library_state.library_files_deduplicated).toBe(0);
  });

  it('still downloads a file that is not quarantined', async () => {
    const { library_state, download } = await run(make_item());

    expect(download).toHaveBeenCalledTimes(1);
    expect(library_state.failed_items).toEqual({});
    expect(library_state.library_entries).toHaveLength(1);
  });

  it('treats a deleted quarantined item as a deletion, not a block', async () => {
    const { library_state, download } = await run(make_item({ quarantined: true, deleted: true }));

    expect(download).not.toHaveBeenCalled();
    expect(library_state.library_deleted_items).toBe(1);
    expect(library_state.failed_items).toEqual({});
  });
});
