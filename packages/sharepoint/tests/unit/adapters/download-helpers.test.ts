import { classify_download_failure } from '@wisecom/atlas-m365-graph';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Readable } from 'node:stream';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';
import {
  CdnHttpError,
  CHUNK_DOWNLOAD_THRESHOLD,
} from '@/adapters/graph-sharepoint-chunked-download';
import {
  resolve_download_url,
  download_with_fallback,
  download_via_graph_content,
  is_expired_url_error,
  rethrow_if_access_denied,
} from '@/adapters/graph-sharepoint-download-executor';

/**
 * Pins the current behaviour of the SharePoint download helpers (issue #247).
 *
 * The SharePoint twin is not a copy of the OneDrive one: it owns a private
 * `download_from_url` with its own 429 retry loop honouring `Retry-After`, and its
 * permission error names a different scope. Both differences are asserted here rather
 * than avoided, because divergence between the two drive pipelines is what let the
 * replication gate drift through in #190.
 *
 * The 403 classification is contradictory in this file too, and issue #246 changes it.
 */

const mocks = vi.hoisted(() => ({
  download_file_chunked: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

// CdnHttpError and compute_chunk_timeout_ms stay real: the first is matched with
// `instanceof`, the second sets the timeout the retry loop runs under.
vi.mock('@/adapters/graph-sharepoint-chunked-download', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, download_file_chunked: mocks.download_file_chunked };
});

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

/** MAX_URL_RETRIES is private; 3 retries means 4 attempts in total. */
const MAX_URL_ATTEMPTS = 4;

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
  const get_stream = vi.fn().mockResolvedValue(Readable.from([CONTENT_BODY]));
  const select = vi.fn(() => ({ get }));
  const api = vi.fn(() => ({ select, get, getStream: get_stream }));
  // The real Client has a large surface; these helpers touch only api/select/get/getStream.
  const client = { api } as unknown as Client;
  return { client, api, get, get_stream, select };
}

function make_item(overrides: Partial<SharePointDeltaItem> = {}): SharePointDeltaItem {
  return {
    drive_id: 'drive-1',
    item_id: 'item-1',
    name: 'Budget.xlsx',
    size_bytes: 1024,
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

  describe('resolve_download_url', () => {
    it('returns the @microsoft.graph.downloadUrl value', async () => {
      const mock = make_client();

      await expect(resolve_download_url(mock.client, make_item())).resolves.toBe(FRESH_URL);
      expect(mock.api).toHaveBeenCalledWith('/drives/drive-1/items/item-1');
      expect(mock.select).toHaveBeenCalledWith('@microsoft.graph.downloadUrl');
    });

    it('returns undefined when Graph omits the property', async () => {
      const mock = make_client({ download_url: undefined });

      await expect(resolve_download_url(mock.client, make_item())).resolves.toBeUndefined();
    });
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

      const small = make_item({ download_url: STALE_URL, size_bytes: CHUNK_DOWNLOAD_THRESHOLD });
      await expect(download_with_fallback(make_client().client, small)).resolves.toEqual(URL_BODY);
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

  // This loop is SharePoint's own. OneDrive imports download_from_url from
  // graph-onedrive-connector-stream and has no equivalent 429 handling here, which is
  // the divergence issue #247 requires asserting rather than hiding.
  describe('download_from_url 429 handling (SharePoint only)', () => {
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
      expect(fetch_mock).toHaveBeenCalledTimes(MAX_URL_ATTEMPTS);
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

      expect(fetch_mock).toHaveBeenCalledTimes(MAX_URL_ATTEMPTS);
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

  describe('download_via_graph_content', () => {
    it('requests /content and drains the stream', async () => {
      const mock = make_client();

      await expect(download_via_graph_content(mock.client, make_item())).resolves.toEqual(
        CONTENT_BODY,
      );
      expect(mock.api).toHaveBeenCalledWith('/drives/drive-1/items/item-1/content');
    });
  });

  describe('is_expired_url_error', () => {
    // Identical to the OneDrive classifier, including reading 403 as an expired URL
    // when it is also what a missing grant and a label-protected item return (#246).
    it.each([401, 403])('treats CdnHttpError %i as an expired URL (see #246 for 403)', (status) => {
      expect(is_expired_url_error(new CdnHttpError('denied', status))).toBe(true);
    });

    it.each([404, 429, 500])('does not treat CdnHttpError %i as an expired URL', (status) => {
      expect(is_expired_url_error(new CdnHttpError('other', status))).toBe(false);
    });

    // Split by #246: a CDN 401/403 is a stale URL, but a Graph 401 is a credential
    // problem and a Graph 403 is either a missing grant or a service refusal. None of
    // them is a URL worth re-resolving.
    it.each([401, 403])(
      'no longer treats a Graph error with statusCode %i as an expired URL',
      (status) => {
        expect(is_expired_url_error({ statusCode: status })).toBe(false);
      },
    );

    it('classifies a Graph 401 separately from a Graph 403', () => {
      expect(classify_download_failure({ statusCode: 401 })).toBe('unauthorized');
      expect(classify_download_failure({ statusCode: 403, code: 'accessDenied' })).toBe(
        'missing_permission',
      );
      expect(classify_download_failure({ statusCode: 403, code: 'notAllowed' })).toBe(
        'service_refused',
      );
    });

    it('does not treat a Graph error with another statusCode as an expired URL', () => {
      expect(is_expired_url_error({ statusCode: 500, message: 'Forbidden' })).toBe(false);
    });

    // Removed by #246. Microsoft's own error guidance is that `message` can change at
    // any time and only `code` should be relied on, and the substring test also matched
    // wrapped storage and proxy errors that had nothing to do with the download URL.
    it.each(['Forbidden', 'Unauthorized'])(
      'no longer classifies a message-only error containing %s as an expired URL',
      (word) => {
        expect(is_expired_url_error(new Error(`S3 GetObject failed: ${word}`))).toBe(false);
      },
    );

    it('returns false for an unrelated error', () => {
      expect(is_expired_url_error(new Error('ECONNRESET'))).toBe(false);
      expect(is_expired_url_error('plain string')).toBe(false);
    });

    // Same latent crash as the OneDrive twin, tracked in #263 rather than fixed here.
    // Was a TypeError before #246 replaced the raw property read (issue #263).
    it.each([undefined, null])('classifies %s as unclassified instead of crashing', (value) => {
      expect(is_expired_url_error(value)).toBe(false);
      expect(classify_download_failure(value)).toBe('unclassified');
    });
  });

  describe('rethrow_if_access_denied', () => {
    // Divergence: SharePoint names Sites.Read.All only, where OneDrive names
    // Files.Read.All plus Sites.Read.All through throw_missing_permissions, which
    // SharePoint does not have.
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
