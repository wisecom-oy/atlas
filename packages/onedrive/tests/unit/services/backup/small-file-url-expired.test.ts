import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OneDriveConnector, OneDriveDeltaItem } from '@wisecom/atlas-types';
import { binary_graph_response } from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  MAX_FAILED_ITEM_ATTEMPTS,
  retryable_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { ONEDRIVE_DOWNLOAD_EXECUTOR } from '@/adapters/graph-onedrive-download-executor';
import {
  process_delta_item,
  type DriveTrackingState,
} from '@/services/backup/delta-item-processor';
import { record_item_outcome_failure } from '@/services/backup/drive-item-outcome';
import type { SingleDriveResult } from '@/services/backup/backup-drive-processor';

// Issue #895: a file below 64 MiB whose download URL expired, whose refreshed URL failed and whose
// /content fallback failed too spent one of its 5 attempts, unlike a large file (#718). The file
// processor and the download executor are the real ones here; only Graph and the host are faked.

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
} as OneDriveDeltaItem;

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

/** The connector calls the file download makes, over the real OneDrive download executor. */
function connector_for(content: () => Response): OneDriveConnector {
  const client = graph_client(content) as never;
  return {
    download_file_content: (item: OneDriveDeltaItem, abort_signal?: AbortSignal) =>
      ONEDRIVE_DOWNLOAD_EXECUTOR.download_with_fallback(client, item, abort_signal),
    resolve_download_url: (item: OneDriveDeltaItem) =>
      ONEDRIVE_DOWNLOAD_EXECUTOR.resolve_download_url(client, item),
    fetch_item_by_id: () => Promise.resolve(ITEM),
  } as unknown as OneDriveConnector;
}

function empty_result(): SingleDriveResult {
  return {
    entries: [],
    files_stored: 0,
    files_deduplicated: 0,
    deleted_items: 0,
    failed_items: {},
    errors: [],
    package_report: { notebooks_detected: 0, section_files_backed_up: 0, warnings: [] },
    interrupted: false,
  };
}

/** One run of the item against `connector`, recorded into `result`. */
async function run_once(result: SingleDriveResult, connector: OneDriveConnector): Promise<void> {
  const tracking: DriveTrackingState = {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
  };
  const pending = process_delta_item(
    connector,
    ITEM,
    'owner-1',
    'snap-1',
    {} as never,
    tracking,
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    () => {},
    { watermarks: {}, pending: {}, rows: new Map() } as never,
  );
  await vi.runAllTimersAsync();
  record_item_outcome_failure(result, new Set(), 'drive-1', ITEM, await pending);
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

describe('OneDrive file below 64 MiB whose download URL expired (issue #895)', () => {
  it('stays listed without spending an attempt when the /content fallback fails too', async () => {
    const result = empty_result();
    const connector = connector_for(() => new Response(null, { status: 401 }));

    for (let run = 0; run < MAX_FAILED_ITEM_ATTEMPTS + 1; run++) {
      await run_once(result, connector);
    }

    expect(result.failed_items['item-1']).toMatchObject({ attempts: 0 });
    expect(result.failed_items['item-1']?.reason).toContain('expired');
    expect(retryable_items(result.failed_items, 'drive-1')).toHaveLength(1);
  });

  it('spends an attempt when /content delivers a body of the wrong size', async () => {
    const result = empty_result();

    await run_once(
      result,
      connector_for(() => binary_graph_response(Buffer.from('short'))),
    );

    expect(result.failed_items['item-1']).toMatchObject({ attempts: 1 });
  });
});
