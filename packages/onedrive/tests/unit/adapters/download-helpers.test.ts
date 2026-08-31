import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
import type { Client } from '@microsoft/microsoft-graph-client';
import { CdnHttpError, CHUNK_DOWNLOAD_THRESHOLD } from '@/adapters/graph-onedrive-chunked-download';
import {
  resolve_download_url,
  download_with_fallback,
  download_via_graph_content,
  is_expired_url_error,
  rethrow_if_access_denied,
  throw_missing_permissions,
} from '@/adapters/graph-onedrive-download-helpers';

/**
 * Pins the current behaviour of the OneDrive download helpers (issue #247). It does
 * not assert that the behaviour is correct: the 403 classification is contradictory
 * by design here, and issue #246 changes it. Tests that describe behaviour expected
 * to change say so and name #246, so that PR gets a failing baseline rather than an
 * assumption.
 */

const mocks = vi.hoisted(() => ({
  download_file_chunked: vi.fn(),
  download_from_url: vi.fn(),
  stream_to_buffer: vi.fn(),
  with_timeout: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

// CdnHttpError stays real: is_expired_url_error branches on `instanceof`, so a stubbed
// class would silently take the wrong branch and the test would prove nothing.
vi.mock('@/adapters/graph-onedrive-chunked-download', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, download_file_chunked: mocks.download_file_chunked };
});

vi.mock('@/adapters/graph-onedrive-connector-stream', () => ({
  download_from_url: mocks.download_from_url,
  stream_to_buffer: mocks.stream_to_buffer,
  with_timeout: mocks.with_timeout,
}));

// Retry policy is owned and tested elsewhere; here it must not multiply call counts.
vi.mock('@wisecom/atlas-m365-graph', () => ({
  with_graph_retry: (fn: () => unknown) => fn(),
}));

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

/** Fake Graph client exposing the fluent chain these helpers use. */
function make_client(overrides: { download_url?: string | undefined } = {}): GraphClientMock {
  const get = vi
    .fn()
    .mockResolvedValue(
      'download_url' in overrides
        ? { '@microsoft.graph.downloadUrl': overrides.download_url }
        : { '@microsoft.graph.downloadUrl': FRESH_URL },
    );
  const get_stream = vi.fn().mockResolvedValue('stream-handle');
  const select = vi.fn(() => ({ get }));
  const api = vi.fn(() => ({ select, get, getStream: get_stream }));
  // The real Client has a large surface; these helpers touch only api/select/get/getStream.
  const client = { api } as unknown as Client;
  return { client, api, get, get_stream, select };
}

function make_item(overrides: Partial<OneDriveDeltaItem> = {}): OneDriveDeltaItem {
  return {
    drive_id: 'drive-1',
    item_id: 'item-1',
    name: 'Report.docx',
    size_bytes: 1024,
    ...overrides,
  } as OneDriveDeltaItem;
}

describe('OneDrive download helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.download_from_url.mockResolvedValue(URL_BODY);
    mocks.download_file_chunked.mockResolvedValue(CHUNK_BODY);
    mocks.stream_to_buffer.mockResolvedValue(CONTENT_BODY);
    mocks.with_timeout.mockImplementation((promise: Promise<unknown>) => promise);
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
      expect(mocks.download_from_url).toHaveBeenCalledWith(STALE_URL, 1024, 'item-1');
      expect(mock.api).not.toHaveBeenCalled();
    });

    it('takes the chunked path above the threshold and the direct path below it', async () => {
      const big = make_item({
        download_url: STALE_URL,
        size_bytes: CHUNK_DOWNLOAD_THRESHOLD + 1,
      });
      await expect(download_with_fallback(make_client().client, big)).resolves.toEqual(CHUNK_BODY);
      expect(mocks.download_file_chunked).toHaveBeenCalledOnce();
      expect(mocks.download_from_url).not.toHaveBeenCalled();

      vi.clearAllMocks();
      mocks.download_from_url.mockResolvedValue(URL_BODY);

      const small = make_item({
        download_url: STALE_URL,
        size_bytes: CHUNK_DOWNLOAD_THRESHOLD,
      });
      await expect(download_with_fallback(make_client().client, small)).resolves.toEqual(URL_BODY);
      expect(mocks.download_from_url).toHaveBeenCalledOnce();
      expect(mocks.download_file_chunked).not.toHaveBeenCalled();
    });

    it('goes to /content without attempting a URL download when no URL resolves', async () => {
      const mock = make_client({ download_url: undefined });

      const body = await download_with_fallback(mock.client, make_item());

      expect(body).toEqual(CONTENT_BODY);
      expect(mocks.download_from_url).not.toHaveBeenCalled();
      expect(mock.get_stream).toHaveBeenCalledOnce();
    });
  });

  describe('expired-URL refresh', () => {
    it('re-resolves exactly once and retries with the refreshed URL', async () => {
      const mock = make_client();
      mocks.download_from_url
        .mockRejectedValueOnce(new CdnHttpError('gone', 401))
        .mockResolvedValueOnce(URL_BODY);

      const body = await download_with_fallback(
        mock.client,
        make_item({ download_url: STALE_URL }),
      );

      expect(body).toEqual(URL_BODY);
      expect(mock.get).toHaveBeenCalledOnce();
      expect(mocks.download_from_url).toHaveBeenNthCalledWith(1, STALE_URL, 1024, 'item-1');
      expect(mocks.download_from_url).toHaveBeenNthCalledWith(2, FRESH_URL, 1024, 'item-1');
      expect(mock.get_stream).not.toHaveBeenCalled();
    });

    it('falls back to /content when the refreshed URL also fails, without surfacing the original error', async () => {
      const mock = make_client();
      mocks.download_from_url
        .mockRejectedValueOnce(new CdnHttpError('stale', 401))
        .mockRejectedValueOnce(new CdnHttpError('still stale', 401));

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
      mocks.download_from_url.mockRejectedValue(new CdnHttpError('server error', 500));

      const body = await download_with_fallback(
        mock.client,
        make_item({ download_url: STALE_URL }),
      );

      expect(body).toEqual(CONTENT_BODY);
      expect(mock.get).not.toHaveBeenCalled();
      expect(mocks.download_from_url).toHaveBeenCalledOnce();
      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('falling back'));
    });

    it('skips the retry and falls back when the refreshed URL cannot be resolved', async () => {
      const mock = make_client({ download_url: undefined });
      mocks.download_from_url.mockRejectedValue(new CdnHttpError('gone', 403));

      await expect(
        download_with_fallback(mock.client, make_item({ download_url: STALE_URL })),
      ).resolves.toEqual(CONTENT_BODY);
      expect(mocks.download_from_url).toHaveBeenCalledOnce();
    });
  });

  describe('download_via_graph_content', () => {
    it('requests /content and drains the stream', async () => {
      const mock = make_client();

      await expect(download_via_graph_content(mock.client, make_item())).resolves.toEqual(
        CONTENT_BODY,
      );
      expect(mock.api).toHaveBeenCalledWith('/drives/drive-1/items/item-1/content');
      // Drain budget is twice the request budget.
      expect(mocks.stream_to_buffer).toHaveBeenCalledWith('stream-handle', 60_000);
      expect(mocks.with_timeout).toHaveBeenCalledWith(
        expect.anything(),
        30_000,
        'Graph content request timed out for file item-1',
      );
    });
  });

  describe('is_expired_url_error', () => {
    // 403 is also what a missing Files.Read.All grant and a label-protected item
    // return, so this branch currently swallows two unrelated causes. Issue #246
    // splits them; these assertions are expected to change with it.
    it.each([401, 403])('treats CdnHttpError %i as an expired URL (see #246 for 403)', (status) => {
      expect(is_expired_url_error(new CdnHttpError('denied', status))).toBe(true);
    });

    it.each([404, 429, 500])('does not treat CdnHttpError %i as an expired URL', (status) => {
      expect(is_expired_url_error(new CdnHttpError('other', status))).toBe(false);
    });

    it.each([401, 403])('treats a Graph error with statusCode %i as an expired URL', (status) => {
      expect(is_expired_url_error({ statusCode: status })).toBe(true);
    });

    it('does not treat a Graph error with another statusCode as an expired URL', () => {
      expect(is_expired_url_error({ statusCode: 500, message: 'Forbidden' })).toBe(false);
    });

    // Substring classification: any wrapped error whose text happens to contain the
    // word is classified as an expired download URL, including a storage or proxy
    // error unrelated to the URL. Issue #246 removes or narrows this.
    it.each(['Forbidden', 'Unauthorized'])(
      'classifies a message-only error containing %s as an expired URL (#246)',
      (word) => {
        expect(is_expired_url_error(new Error(`S3 GetObject failed: ${word}`))).toBe(true);
      },
    );

    it('returns false for an unrelated error', () => {
      expect(is_expired_url_error(new Error('ECONNRESET'))).toBe(false);
      expect(is_expired_url_error('plain string')).toBe(false);
      expect(is_expired_url_error(0)).toBe(false);
    });

    // Found while writing this suite, and left unfixed on purpose: issue #247 pins
    // behaviour and rules that anything beyond the 403 classification gets its own
    // issue. The classifier reads `.statusCode` off the raw value, so a rejection
    // carrying no reason (`Promise.reject()`) crashes the classifier instead of
    // being classified. Tracked in #263.
    it.each([undefined, null])(
      'currently throws a TypeError for %s rather than returning false',
      (value) => {
        expect(() => is_expired_url_error(value)).toThrow(TypeError);
      },
    );
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
      // The CDN error uses status_code, not statusCode, so the permission path never
      // sees a CDN refusal. Recorded rather than endorsed (#246).
      expect(() => rethrow_if_access_denied(new CdnHttpError('denied', 403))).not.toThrow();
    });
  });

  describe('throw_missing_permissions', () => {
    it('names read permissions by default and write permissions on request', () => {
      expect(() => throw_missing_permissions()).toThrow(/Files\.Read\.All, Sites\.Read\.All/);
      expect(() => throw_missing_permissions('write')).toThrow(
        /Files\.ReadWrite\.All, Sites\.Read\.All/,
      );
    });
  });
});
