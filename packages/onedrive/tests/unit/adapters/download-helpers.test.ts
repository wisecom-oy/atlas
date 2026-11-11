import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { binary_graph_response } from '@wisecom/atlas-types/testing/queued-graph-fetch';
import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
import type { Client } from '@microsoft/microsoft-graph-client';
import { CdnHttpError } from '@wisecom/atlas-drive/backup/cdn-chunk-errors';
import { CHUNK_DOWNLOAD_THRESHOLD } from '@wisecom/atlas-drive/backup/cdn-chunk-download';
import { ONEDRIVE_DOWNLOAD_EXECUTOR } from '@/adapters/graph-onedrive-download-executor';

/**
 * The OneDrive binding of the shared download executor, driven through `fetch`.
 *
 * Only the chunk downloader is stubbed. The URL download is the real one: this suite used to
 * stub it with a function rejecting `CdnHttpError`, which the OneDrive copy never threw, so the
 * refresh it asserted never happened in a real run (issue #675).
 */

const { download_with_fallback, rethrow_if_access_denied } = ONEDRIVE_DOWNLOAD_EXECUTOR;

const mocks = vi.hoisted(() => ({
  download_file_chunked: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/adapters/graph-onedrive-chunk-downloader', () => ({
  ONEDRIVE_CHUNK_DOWNLOADER: {
    download_file_chunked: mocks.download_file_chunked,
    fetch_file_chunks: vi.fn(),
  },
}));

// Only the retry wrapper is stubbed, so it cannot multiply call counts. The download
// classifier is real: it is the behaviour under test (issue #246).
vi.mock('@wisecom/atlas-m365-graph', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, with_graph_retry: (fn: () => unknown) => fn() };
});

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: mocks.warn, debug: mocks.debug, info: vi.fn(), error: vi.fn() },
}));

const URL_BODY = Buffer.from('url-download');
const CHUNK_BODY = Buffer.from('chunked-download');
const CONTENT_BODY = Buffer.from('graph-content');
const FRESH_URL = 'https://cdn.example.invalid/fresh';
const STALE_URL = 'https://cdn.example.invalid/stale';

interface GraphClientMock {
  /** The fake, shaped for the helpers' parameter type so call sites need no cast. */
  client: Client;
  api: Mock;
  get: Mock;
  get_stream: Mock;
}

/** Fake Graph client exposing the fluent chain these helpers use. */
function make_client(overrides: { download_url?: string | undefined } = {}): GraphClientMock {
  const get = vi
    .fn()
    .mockResolvedValue(
      'download_url' in overrides
        ? { '@microsoft.graph.downloadUrl': overrides.download_url }
        : { '@microsoft.graph.downloadUrl': FRESH_URL },
    );
  const get_stream = vi.fn(() => Promise.resolve(binary_graph_response(CONTENT_BODY)));
  const select = vi.fn(() => ({ get }));
  const api = vi.fn(() => ({ select, get, responseType: () => ({ get: get_stream }) }));
  // The real Client has a large surface; these helpers touch only api/select/get/responseType.
  const client = { api } as unknown as Client;
  return { client, api, get, get_stream };
}

/**
 * `size_bytes` defaults to 0, which `assert_transferred_size` reads as "no recorded size" and
 * skips. These cases are about routing and refresh, not transfer length (issue #368).
 */
function make_item(overrides: Partial<OneDriveDeltaItem> = {}): OneDriveDeltaItem {
  return {
    drive_id: 'drive-1',
    item_id: 'item-1',
    name: 'Report.docx',
    size_bytes: 0,
    ...overrides,
  } as OneDriveDeltaItem;
}

/** Minimal fetch Response stand-in: only the fields the URL download reads. */
function make_response(init: { status: number; body?: Buffer; retry_after?: string }): Response {
  const headers = new Headers();
  if (init.retry_after !== undefined) headers.set('Retry-After', init.retry_after);
  const body = init.body ?? URL_BODY;
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers,
    arrayBuffer: () =>
      Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
  } as unknown as Response;
}

describe('OneDrive download executor', () => {
  let fetch_mock: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.download_file_chunked.mockResolvedValue(CHUNK_BODY);
    fetch_mock = vi.fn().mockResolvedValue(make_response({ status: 200 }));
    vi.stubGlobal('fetch', fetch_mock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('routing', () => {
    it("uses the item's existing download_url without re-resolving", async () => {
      const mock = make_client();

      const body = await download_with_fallback(
        mock.client,
        make_item({ download_url: STALE_URL }),
      );

      expect(body).toEqual(URL_BODY);
      expect(fetch_mock).toHaveBeenCalledWith(STALE_URL, expect.anything());
      expect(mock.api).not.toHaveBeenCalled();
    });

    it('takes the chunked path above the threshold and the direct path at it', async () => {
      const big = make_item({ download_url: STALE_URL, size_bytes: CHUNK_DOWNLOAD_THRESHOLD + 1 });
      await expect(download_with_fallback(make_client().client, big)).resolves.toEqual(CHUNK_BODY);
      expect(mocks.download_file_chunked).toHaveBeenCalledOnce();
      expect(fetch_mock).not.toHaveBeenCalled();

      const at_threshold = Buffer.alloc(CHUNK_DOWNLOAD_THRESHOLD, 1);
      fetch_mock.mockResolvedValue(make_response({ status: 200, body: at_threshold }));
      const small = make_item({ download_url: STALE_URL, size_bytes: CHUNK_DOWNLOAD_THRESHOLD });
      const body = await download_with_fallback(make_client().client, small);
      expect(body.length).toBe(CHUNK_DOWNLOAD_THRESHOLD);
      expect(fetch_mock).toHaveBeenCalledOnce();
      expect(mocks.download_file_chunked).toHaveBeenCalledOnce();
    });

    it('goes to /content without attempting a URL download when no URL resolves', async () => {
      const mock = make_client({ download_url: undefined });

      const body = await download_with_fallback(mock.client, make_item());

      expect(body).toEqual(CONTENT_BODY);
      expect(fetch_mock).not.toHaveBeenCalled();
      expect(mock.get_stream).toHaveBeenCalledOnce();
    });
  });

  describe('expired-URL refresh (issue #675)', () => {
    it.each([401, 403])(
      're-resolves once after a CDN %i and downloads from the fresh URL',
      async (status) => {
        const mock = make_client();
        fetch_mock
          .mockResolvedValueOnce(make_response({ status }))
          .mockResolvedValueOnce(make_response({ status: 200 }));

        const body = await download_with_fallback(
          mock.client,
          make_item({ download_url: STALE_URL }),
        );

        expect(body).toEqual(URL_BODY);
        expect(mock.get).toHaveBeenCalledOnce();
        expect(fetch_mock).toHaveBeenNthCalledWith(1, STALE_URL, expect.anything());
        expect(fetch_mock).toHaveBeenNthCalledWith(2, FRESH_URL, expect.anything());
        expect(mock.get_stream).not.toHaveBeenCalled();
      },
    );

    it('falls back to /content when the refreshed URL also fails', async () => {
      const mock = make_client();
      fetch_mock.mockResolvedValue(make_response({ status: 403 }));

      const body = await download_with_fallback(
        mock.client,
        make_item({ download_url: STALE_URL }),
      );

      expect(body).toEqual(CONTENT_BODY);
      expect(mock.get_stream).toHaveBeenCalledOnce();
      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('retry failed for item-1'));
    });

    it('goes straight to /content without re-resolving for a non-expired failure', async () => {
      const mock = make_client();
      fetch_mock.mockResolvedValue(make_response({ status: 500 }));

      const body = await download_with_fallback(
        mock.client,
        make_item({ download_url: STALE_URL }),
      );

      expect(body).toEqual(CONTENT_BODY);
      expect(mock.get).not.toHaveBeenCalled();
      expect(fetch_mock).toHaveBeenCalledOnce();
      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));
    });

    it('skips the retry and falls back when the refreshed URL cannot be resolved', async () => {
      const mock = make_client({ download_url: undefined });
      fetch_mock.mockResolvedValue(make_response({ status: 403 }));

      await expect(
        download_with_fallback(mock.client, make_item({ download_url: STALE_URL })),
      ).resolves.toEqual(CONTENT_BODY);
      expect(fetch_mock).toHaveBeenCalledOnce();
    });
  });

  describe('429 handling (issue #675)', () => {
    it('waits out Retry-After and retries the same URL instead of falling back', async () => {
      vi.useFakeTimers();
      const mock = make_client();
      fetch_mock
        .mockResolvedValueOnce(make_response({ status: 429, retry_after: '3' }))
        .mockResolvedValueOnce(make_response({ status: 200 }));

      const pending = download_with_fallback(mock.client, make_item({ download_url: STALE_URL }));
      await vi.advanceTimersByTimeAsync(2_999);
      expect(fetch_mock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toEqual(URL_BODY);
      expect(fetch_mock).toHaveBeenCalledTimes(2);
      expect(fetch_mock).toHaveBeenNthCalledWith(2, STALE_URL, expect.anything());
      expect(mocks.debug).toHaveBeenCalledWith(expect.stringContaining('retry in 3000ms'));
      expect(mock.get).not.toHaveBeenCalled();
      expect(mock.get_stream).not.toHaveBeenCalled();
    });

    it('falls back to /content only after the retries are spent', async () => {
      const mock = make_client();
      fetch_mock.mockResolvedValue(make_response({ status: 429, retry_after: '0' }));

      const body = await download_with_fallback(
        mock.client,
        make_item({ download_url: STALE_URL }),
      );

      expect(body).toEqual(CONTENT_BODY);
      // MAX_URL_RETRIES is 3, so four attempts in total.
      expect(fetch_mock).toHaveBeenCalledTimes(4);
      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 429'));
    });
  });

  describe('rethrow_if_access_denied', () => {
    it('throws only on statusCode 403, naming the permissions to grant', () => {
      expect(() => rethrow_if_access_denied({ statusCode: 403 })).toThrow(
        'Missing Microsoft Graph application permissions for OneDrive: Files.Read.All, Sites.Read.All.',
      );
    });

    it.each([401, 404, 500, undefined])('is a no-op for statusCode %s', (status) => {
      expect(() => rethrow_if_access_denied({ statusCode: status })).not.toThrow();
    });

    it('is a no-op for a CdnHttpError carrying 403, because it reads statusCode only', () => {
      expect(() => rethrow_if_access_denied(new CdnHttpError('denied', 403))).not.toThrow();
    });
  });
});
