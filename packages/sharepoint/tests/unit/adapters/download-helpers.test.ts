import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { binary_graph_response } from '@wisecom/atlas-types/testing/queued-graph-fetch';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';
import { CdnHttpError } from '@wisecom/atlas-drive/backup/cdn-chunk-errors';
import { CHUNK_DOWNLOAD_THRESHOLD } from '@wisecom/atlas-drive/backup/cdn-chunk-download';
import { MAX_URL_RETRIES } from '@wisecom/atlas-drive/backup/cdn-url-download';
import { SHAREPOINT_DOWNLOAD_EXECUTOR } from '@/adapters/graph-sharepoint-download-executor';

/**
 * The SharePoint binding of the shared download executor, driven through `fetch`. The helpers it
 * shares with OneDrive are tested once in the drive package; this suite pins the routing, the
 * refresh, the 429 loop and the permission scope SharePoint names.
 */

const { download_with_fallback, rethrow_if_access_denied } = SHAREPOINT_DOWNLOAD_EXECUTOR;

const mocks = vi.hoisted(() => ({
  download_file_chunked: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

// Only the chunk downloader is stubbed. CdnHttpError and compute_chunk_timeout_ms stay real: the
// first is matched with `instanceof`, the second sets the timeout the retry loop runs under.
vi.mock('@/adapters/graph-sharepoint-chunk-downloader', () => ({
  SHAREPOINT_CHUNK_DOWNLOADER: {
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
  select: Mock;
}

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
  return { client, api, get, get_stream, select };
}

/**
 * `size_bytes` defaults to 0, which `assert_transferred_size` reads as "no recorded size" and
 * skips. These cases are about routing and refresh, not about transfer length, so they should
 * not have to keep a fixture body and a fixture size in step (issue #368).
 */
function make_item(overrides: Partial<SharePointDeltaItem> = {}): SharePointDeltaItem {
  return {
    drive_id: 'drive-1',
    item_id: 'item-1',
    name: 'Budget.xlsx',
    size_bytes: 0,
    ...overrides,
  } as SharePointDeltaItem;
}

/** Minimal fetch Response stand-in: only the fields download_from_url reads. */
function make_response(init: { status: number; body?: Buffer; retry_after?: string }): Response {
  const headers = new Headers();
  if (init.retry_after !== undefined) headers.set('Retry-After', init.retry_after);
  const body = init.body ?? URL_BODY;
  const response = {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers,
    arrayBuffer: () =>
      Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
  };
  return response as unknown as Response;
}

describe('SharePoint download helpers', () => {
  let fetch_mock: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.download_file_chunked.mockResolvedValue(CHUNK_BODY);
    fetch_mock = vi.fn().mockResolvedValue(make_response({ status: 200 }));
    vi.stubGlobal('fetch', fetch_mock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('download_with_fallback routing', () => {
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

    it('takes the chunked path above the threshold and the direct path below it', async () => {
      const big = make_item({ download_url: STALE_URL, size_bytes: CHUNK_DOWNLOAD_THRESHOLD + 1 });
      await expect(download_with_fallback(make_client().client, big)).resolves.toEqual(CHUNK_BODY);
      expect(mocks.download_file_chunked).toHaveBeenCalledOnce();
      expect(fetch_mock).not.toHaveBeenCalled();

      // At the threshold exactly, so it takes the direct path. The body has to be that long now
      // that a short one is an integrity failure rather than a silent truncation (issue #368).
      // Asserted by length: a deep compare of 4 MiB takes seconds.
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

  describe('expired-URL refresh', () => {
    it('re-resolves exactly once and retries with the refreshed URL', async () => {
      const mock = make_client();
      fetch_mock
        .mockResolvedValueOnce(make_response({ status: 401 }))
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
    });

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
      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('falling back'));
    });
  });

  describe('download_from_url 429 handling', () => {
    it('retries 429 honouring Retry-After and then succeeds', async () => {
      fetch_mock
        .mockResolvedValueOnce(make_response({ status: 429, retry_after: '0' }))
        .mockResolvedValueOnce(make_response({ status: 200 }));

      const body = await download_with_fallback(
        make_client().client,
        make_item({ download_url: STALE_URL }),
      );

      expect(body).toEqual(URL_BODY);
      expect(fetch_mock).toHaveBeenCalledTimes(2);
      expect(mocks.debug).toHaveBeenCalledWith(expect.stringContaining('HTTP 429'));
    });

    it('gives up after MAX_URL_RETRIES and raises CdnHttpError carrying 429', async () => {
      fetch_mock.mockResolvedValue(make_response({ status: 429, retry_after: '0' }));
      const mock = make_client();

      // The CdnHttpError surfaces into attempt_download_with_refresh, which classifies
      // 429 as not-expired and falls back to /content rather than propagating it.
      const body = await download_with_fallback(
        mock.client,
        make_item({ download_url: STALE_URL }),
      );

      expect(body).toEqual(CONTENT_BODY);
      expect(fetch_mock).toHaveBeenCalledTimes(MAX_URL_RETRIES + 1);
      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 429'));
      expect(mock.get).not.toHaveBeenCalled();
    });

    // A 429 with no Retry-After header falls back to exponential backoff. Asserted on
    // the final attempt, which throws without sleeping, so the suite pays no delay.
    it('omits retry_after_ms on the raised error when the header is absent', async () => {
      fetch_mock
        .mockResolvedValueOnce(make_response({ status: 429, retry_after: '0' }))
        .mockResolvedValueOnce(make_response({ status: 429, retry_after: '0' }))
        .mockResolvedValueOnce(make_response({ status: 429, retry_after: '0' }))
        .mockResolvedValueOnce(make_response({ status: 429 }));
      const mock = make_client();

      await download_with_fallback(mock.client, make_item({ download_url: STALE_URL }));

      expect(fetch_mock).toHaveBeenCalledTimes(MAX_URL_RETRIES + 1);
      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 429'));
    });

    it('raises CdnHttpError carrying the status for a non-ok response', async () => {
      fetch_mock.mockResolvedValue(make_response({ status: 404 }));
      const mock = make_client();

      await download_with_fallback(mock.client, make_item({ download_url: STALE_URL }));

      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 404'));
      expect(fetch_mock).toHaveBeenCalledOnce();
    });
  });

  describe('rethrow_if_access_denied', () => {
    it('throws only on statusCode 403, naming the SharePoint scope', () => {
      expect(() => rethrow_if_access_denied({ statusCode: 403 })).toThrow(
        'Missing Microsoft Graph application permissions for SharePoint: Sites.Read.All.',
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
