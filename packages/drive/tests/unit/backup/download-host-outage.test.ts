import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import { binary_graph_response } from '@wisecom/atlas-types/testing/queued-graph-fetch';
import { CHUNK_DOWNLOAD_THRESHOLD } from '@/backup/cdn-chunk-download';
import { CdnHttpError, ChunkDownloadError } from '@/backup/cdn-chunk-errors';
import { download_with_retry } from '@/backup/download-retry';
import { TransientDownloadError } from '@/backup/transient-download-failure';
import type { DriveContentConnector } from '@/drive-ports';
import {
  chunk_downloader,
  content_client_rig,
  drive_bindings,
  drive_file,
  executor_connector,
  graph_status_response,
  stalled_request,
} from './content-fallback.fixtures';

// Issue #885: while the download hosts failed every request, each file fell back to /content, which
// redirects to the same hosts, and waited out Graph's 12-retry budget there, three times over, one
// file after another. A failure of the host itself now goes to the file-level retry instead, so a
// file's wait is bounded by its 3 attempts, and the file is listed without spending an attempt.

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const LISTED_URL = 'https://cdn.example.invalid/listed';
const BODY = Buffer.from('file-body');
const SMALL_FILE = drive_file(BODY.length, LISTED_URL);
const CHUNKED_FILE = drive_file(CHUNK_DOWNLOAD_THRESHOLD * 2, LISTED_URL);

/** A small file's single request, or a stall per file attempt, whichever is the longer: 30 s. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The two file-level backoffs: 2 s and 4 s, each with up to 2 s of jitter. */
const MAX_FILE_BACKOFF_MS = 4_000 + 6_000;

const download_file_chunked: Mock = vi.fn();
let fetch_mock: Mock;

beforeEach(() => {
  vi.useFakeTimers();
  fetch_mock = vi.fn();
  vi.stubGlobal('fetch', fetch_mock);
  download_file_chunked.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Runs the file-level download to its end and reports what it settled with and how long it took. */
async function timed_download(connector: DriveContentConnector, item = SMALL_FILE) {
  const started_at = Date.now();
  const outcome = download_with_retry(connector, item).catch((err: unknown) => err);
  await vi.runAllTimersAsync();
  return { result: await outcome, elapsed_ms: Date.now() - started_at };
}

describe.each(drive_bindings(chunk_downloader(download_file_chunked)))(
  'a download host outage, bound to %s (issue #885)',
  (_label, binding) => {
    it('lists a file the host answers 503 within 3 attempts and seconds, never trying /content', async () => {
      fetch_mock.mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
      const rig = content_client_rig(() => Promise.resolve(binary_graph_response(BODY)));

      const { result, elapsed_ms } = await timed_download(executor_connector(binding, rig.client));

      expect(result).toBeInstanceOf(TransientDownloadError);
      expect((result as Error).cause).toBeInstanceOf(CdnHttpError);
      expect(fetch_mock).toHaveBeenCalledTimes(3);
      expect(rig.content_requests).not.toHaveBeenCalled();
      expect(elapsed_ms).toBeLessThanOrEqual(MAX_FILE_BACKOFF_MS);
    });

    it('bounds a file to 3 request timeouts and the backoff while the host stalls', async () => {
      fetch_mock.mockImplementation((_url: string, init: RequestInit) =>
        stalled_request(init.signal as AbortSignal),
      );
      const rig = content_client_rig(() => Promise.resolve(binary_graph_response(BODY)));

      const { result, elapsed_ms } = await timed_download(executor_connector(binding, rig.client));

      expect(result).toBeInstanceOf(TransientDownloadError);
      expect(fetch_mock).toHaveBeenCalledTimes(3);
      expect(rig.content_requests).not.toHaveBeenCalled();
      expect(elapsed_ms).toBeLessThanOrEqual(3 * REQUEST_TIMEOUT_MS + MAX_FILE_BACKOFF_MS);
    });

    it('does not send a chunked download whose range kept failing to /content', async () => {
      const unavailable = new CdnHttpError('HTTP 503', 503);
      download_file_chunked.mockRejectedValue(new ChunkDownloadError('chunk 1', unavailable));
      const rig = content_client_rig(() => Promise.resolve(binary_graph_response(BODY)));

      const { result } = await timed_download(
        executor_connector(binding, rig.client),
        CHUNKED_FILE,
      );

      expect(result).toBeInstanceOf(TransientDownloadError);
      expect(download_file_chunked).toHaveBeenCalledTimes(3);
      expect(rig.content_requests).not.toHaveBeenCalled();
    });

    it('still re-resolves an expired URL once and falls back to /content', async () => {
      const fresh_url = 'https://cdn.example.invalid/fresh';
      fetch_mock.mockImplementation(() => Promise.resolve(new Response(null, { status: 401 })));
      const rig = content_client_rig(
        () => Promise.resolve(binary_graph_response(BODY)),
        () => Promise.resolve({ '@microsoft.graph.downloadUrl': fresh_url }),
      );

      const { result } = await timed_download(executor_connector(binding, rig.client));

      expect(result).toEqual(BODY);
      expect(rig.url_lookups).toHaveBeenCalledOnce();
      expect(fetch_mock).toHaveBeenNthCalledWith(2, fresh_url, expect.anything());
      expect(rig.content_requests).toHaveBeenCalledOnce();
    });

    it('still waits out the Retry-After of a throttled /content', async () => {
      const rig = content_client_rig(() =>
        Promise.resolve(
          rig.content_requests.mock.calls.length === 1
            ? graph_status_response(429, { 'Retry-After': '20' })
            : binary_graph_response(BODY),
        ),
      );
      // No URL from the listing or the lookup, so the file goes straight to /content.
      const outcome = download_with_retry(
        executor_connector(binding, rig.client),
        drive_file(BODY.length),
      ).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(rig.content_requests).toHaveBeenCalledOnce();
      await vi.runAllTimersAsync();

      expect(rig.content_requests).toHaveBeenCalledTimes(2);
      expect(await outcome).toEqual(BODY);
    });
  },
);

describe('a failure that already spent the Graph retry budget (issue #885)', () => {
  it('is listed after one attempt instead of waiting out the budget twice more', async () => {
    const outage = new GraphUnavailableError('Graph kept failing', { retries: 12, elapsed_ms: 1 });
    const download_file_content = vi.fn().mockRejectedValue(outage);

    const { result } = await timed_download({
      download_file_content,
    } as unknown as DriveContentConnector);

    expect(result).toBeInstanceOf(TransientDownloadError);
    expect((result as Error).cause).toBe(outage);
    expect(download_file_content).toHaveBeenCalledOnce();
  });
});
