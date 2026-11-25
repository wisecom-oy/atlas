import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  is_retry_exhausted,
  MAX_FAILED_ITEM_ATTEMPTS,
  record_item_failure,
  retryable_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { DownloadRefusedError } from '@wisecom/atlas-m365-graph';
import type { FailedItemLedger } from '@wisecom/atlas-types';
import type { CdnChunkDownloader } from '@/backup/cdn-chunk-download';
import { download_with_retry } from '@/backup/download-retry';
import { create_drive_download_executor } from '@/backup/drive-download-executor';
import type { DriveGraphClient } from '@/backup/graph-item-content';
import type { DriveContentConnector, DriveDeltaItem } from '@/drive-ports';

// Issue #866: a Graph 403 on the fresh-URL lookup whose code Atlas does not recognise used to mark
// the file permanently skipped after one occurrence. It now fails the file for one run, and only
// the attempt budget makes it permanent.

vi.mock('@wisecom/atlas-m365-graph', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, with_graph_retry: (fn: () => unknown) => fn() };
});

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const CHUNK_DOWNLOADER: CdnChunkDownloader = {
  fetch_file_chunks: vi.fn(),
  download_file_chunked: vi.fn(),
};

const executor = create_drive_download_executor({
  workload: 'onedrive',
  read_permissions: ['Files.Read.All', 'Sites.Read.All'],
  chunk_downloader: CHUNK_DOWNLOADER,
});

const ITEM = {
  drive_id: 'drive-1',
  item_id: 'item-1',
  kind: 'file',
  file_name: 'Report.docx',
  parent_path: '/',
  size_bytes: 0,
  deleted: false,
  download_url: 'https://cdn.example.invalid/stale',
} as DriveDeltaItem;

/** A connector whose fresh-URL lookup fails with `lookup_error`, after the CDN answered 401. */
function connector_refusing_lookup(lookup_error: unknown): DriveContentConnector {
  const get = vi.fn(() => Promise.reject(lookup_error));
  const api = vi.fn(() => ({ select: () => ({ get }), get }));
  const client = { api } as unknown as DriveGraphClient;
  return {
    download_file_content: (item, abort_signal) =>
      executor.download_with_fallback(client, item, abort_signal),
  } as DriveContentConnector;
}

function record_run(ledger: FailedItemLedger, reason: string): FailedItemLedger {
  return record_item_failure(ledger, {
    item_id: ITEM.item_id,
    drive_id: ITEM.drive_id,
    name: ITEM.file_name,
    reason,
  });
}

describe('unrecognised 403 on the download-URL lookup (issue #866)', () => {
  let fetch_mock: Mock;

  beforeEach(() => {
    fetch_mock = vi.fn(() => Promise.resolve({ status: 401, ok: false, headers: new Headers() }));
    vi.stubGlobal('fetch', fetch_mock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([{ statusCode: 403, code: 'notAllowed' }, { statusCode: 403 }])(
    'skips the file for this run instead of rethrowing a permanent refusal (%o)',
    async (lookup_error) => {
      const body = await download_with_retry(connector_refusing_lookup(lookup_error), ITEM, {
        max_attempts: 1,
      });

      expect(body).toBeUndefined();
    },
  );

  it('still rethrows a known permanent refusal for the caller to record', async () => {
    const lookup_error = { statusCode: 403, code: 'malwareDetected' };

    await expect(
      download_with_retry(connector_refusing_lookup(lookup_error), ITEM, { max_attempts: 1 }),
    ).rejects.toBeInstanceOf(DownloadRefusedError);
  });

  it('keeps the file retryable until it spends the attempt budget', () => {
    let ledger: FailedItemLedger = {};

    for (let run = 1; run < MAX_FAILED_ITEM_ATTEMPTS; run++) {
      ledger = record_run(ledger, 'file content could not be downloaded');
      expect(retryable_items(ledger, ITEM.drive_id)).toHaveLength(1);
    }
    ledger = record_run(ledger, 'file content could not be downloaded');

    expect(is_retry_exhausted(ledger[ITEM.item_id]!)).toBe(true);
    expect(ledger[ITEM.item_id]!.permanent).toBeUndefined();
  });
});
