import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharePointDeltaItem, SharePointSiteConnector } from '@wisecom/atlas-types';
import { binary_graph_response } from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  MAX_FAILED_ITEM_ATTEMPTS,
  retryable_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { SHAREPOINT_DOWNLOAD_EXECUTOR } from '@/adapters/graph-sharepoint-download-executor';
import {
  process_delta_item,
  type FileTrackingState,
  type LibraryProcessingState,
} from '@/services/backup/library-item-processor';

// Issue #895, SharePoint twin of the OneDrive test: a file below 64 MiB whose URL expired and whose
// refresh and /content fallback failed too is recorded without spending an attempt. The file
// processor and the download executor are the real ones; only Graph and the host are faked.

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const ITEM = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  kind: 'file',
  file_name: 'report.docx',
  parent_path: '/Documents',
  size_bytes: 16,
  deleted: false,
  etag: 'etag-1',
  last_modified_at: '2026-08-01T00:00:00Z',
  download_url: 'https://cdn.example.invalid/listed',
} as SharePointDeltaItem;

/** A Graph client whose URL lookup offers a fresh link and whose `/content` answers `content`. */
function graph_client(content: () => Response) {
  const lookup = () =>
    Promise.resolve({ '@microsoft.graph.downloadUrl': 'https://cdn.example.invalid/fresh' });
  const request = {
    select: () => ({ get: lookup }),
    option: () => request,
    responseType: () => ({ get: () => Promise.resolve(content()) }),
  };
  return { api: () => request };
}

/** The connector calls the file download makes, over the real SharePoint download executor. */
function connector_for(content: () => Response): SharePointSiteConnector {
  const client = graph_client(content) as never;
  return {
    download_file_content: (item: SharePointDeltaItem, abort_signal?: AbortSignal) =>
      SHAREPOINT_DOWNLOAD_EXECUTOR.download_with_fallback(client, item, abort_signal),
    resolve_download_url: (item: SharePointDeltaItem) =>
      SHAREPOINT_DOWNLOAD_EXECUTOR.resolve_download_url(client, item),
    fetch_item_by_id: () => Promise.resolve(ITEM),
  } as unknown as SharePointSiteConnector;
}

function empty_library(): LibraryProcessingState {
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

/** One run of the item against `connector`, recorded into `library`. */
async function run_once(
  library: LibraryProcessingState,
  connector: SharePointSiteConnector,
): Promise<void> {
  const tracking: FileTrackingState = {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
  };
  const pending = process_delta_item(
    connector,
    ITEM,
    'site-1',
    'snap-1',
    {} as never,
    tracking,
    library,
    { watermarks: {}, pending: {}, rows: new Map() } as never,
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
  );
  await vi.runAllTimersAsync();
  await pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  // The download host says the link expired, the refreshed one included.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SharePoint file below 64 MiB whose download URL expired (issue #895)', () => {
  it('stays listed without spending an attempt when the /content fallback fails too', async () => {
    const library = empty_library();
    const connector = connector_for(() => new Response(null, { status: 401 }));

    for (let run = 0; run < MAX_FAILED_ITEM_ATTEMPTS + 1; run++) {
      await run_once(library, connector);
    }

    expect(library.failed_items['item-1']).toMatchObject({ attempts: 0 });
    expect(library.failed_items['item-1']?.reason).toContain('expired');
    expect(retryable_items(library.failed_items, 'drive-1')).toHaveLength(1);
  });

  it('spends an attempt when /content delivers a body of the wrong size', async () => {
    const library = empty_library();

    await run_once(
      library,
      connector_for(() => binary_graph_response(Buffer.from('short'))),
    );

    expect(library.failed_items['item-1']).toMatchObject({ attempts: 1 });
  });
});
