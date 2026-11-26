import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { binary_graph_response } from '@wisecom/atlas-types/testing/queued-graph-fetch';
import { CHUNK_DOWNLOAD_THRESHOLD } from '@/backup/cdn-chunk-download';
import { CdnHttpError, ChunkDownloadError } from '@/backup/cdn-chunk-errors';
import { process_drive_backup_file } from '@/backup/file-processor';
import { DownloadUrlExpiredError } from '@/backup/large-file-url-refresh';
import { spares_failed_item_attempt } from '@/backup/transient-download-failure';
import type { DriveDeltaItem } from '@/drive-ports';
import { build_drive_storage_keys } from '@/shared/storage-keys';
import {
  chunk_downloader,
  content_client_rig,
  drive_bindings,
  drive_file,
  executor_connector,
  graph_status_response,
  type ContentAnswer,
} from './content-fallback.fixtures';

// Issue #895: below 64 MiB, a file whose URL expired, whose refreshed URL failed and whose /content
// fallback failed too lost the cause on the way to the recorder and spent one of its 5 attempts.
// Only the large-file path recorded it without one, although the docs said it held at any size.

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const LISTED_URL = 'https://cdn.example.invalid/listed';
const FRESH_URL = 'https://cdn.example.invalid/fresh';
const SMALL_FILE = drive_file(16, LISTED_URL);
const CHUNKED_FILE = drive_file(CHUNK_DOWNLOAD_THRESHOLD * 2, LISTED_URL);

const download_file_chunked: Mock = vi.fn();
let fetch_mock: Mock;

beforeEach(() => {
  vi.useFakeTimers();
  // Every request to the download host says the link expired, the refreshed one included.
  fetch_mock = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })));
  vi.stubGlobal('fetch', fetch_mock);
  download_file_chunked.mockReset();
  download_file_chunked.mockRejectedValue(
    new ChunkDownloadError('chunk 1', new CdnHttpError('HTTP 403', 403)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each(drive_bindings(chunk_downloader(download_file_chunked)))(
  'a file below 64 MiB whose URL expired, bound to %s (issue #895)',
  (_label, binding) => {
    /** Processes `item` with /content answering `content`, and reports how it settled. */
    async function process_file(item: DriveDeltaItem, content: ContentAnswer) {
      const rig = content_client_rig(content, () =>
        Promise.resolve({ '@microsoft.graph.downloadUrl': FRESH_URL }),
      );
      const refetch = vi.fn().mockResolvedValue(item);
      const outcome = process_drive_backup_file(
        { keys: build_drive_storage_keys(binding.workload), fetch_chunks: vi.fn() },
        executor_connector(binding, rig.client),
        item,
        'owner-1',
        {} as TenantContext,
        refetch,
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.runAllTimersAsync();
      return { settled: await outcome, rig };
    }

    it.each([
      ['a single-request file', SMALL_FILE],
      ['a chunked file', CHUNKED_FILE],
    ])('records %s without spending an attempt when /content fails too', async (_kind, item) => {
      const { settled, rig } = await process_file(item, () =>
        Promise.resolve(graph_status_response(401)),
      );

      expect(settled).toEqual({ error: expect.any(DownloadUrlExpiredError) });
      expect(spares_failed_item_attempt((settled as { error: unknown }).error)).toBe(true);
      // One refresh and one /content fallback: the expiry is not repeated at file level. The
      // fallback's 401 is sent twice, as Graph repeats any 401 once with a new token (issue #861).
      expect(rig.url_lookups).toHaveBeenCalledOnce();
      expect(rig.content_requests).toHaveBeenCalledTimes(2);
    });

    it('spends an attempt when /content delivers a body of the wrong size after the refresh', async () => {
      const { settled } = await process_file(SMALL_FILE, () =>
        Promise.resolve(binary_graph_response(Buffer.from('short'))),
      );

      // The size mismatch is the file's own: the re-read finds the same size and the file is
      // skipped, which the caller records with an attempt.
      expect(settled).toEqual({ value: undefined });
    });

    it('spends an attempt when /content says the file is gone', async () => {
      const { settled } = await process_file(SMALL_FILE, () =>
        Promise.resolve(graph_status_response(404)),
      );

      expect(settled).toEqual({ value: undefined });
    });
  },
);
