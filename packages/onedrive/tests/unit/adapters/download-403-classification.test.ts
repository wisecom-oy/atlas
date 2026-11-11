import { classify_download_failure, DownloadRefusedError } from '@wisecom/atlas-m365-graph';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { binary_graph_response } from '@wisecom/atlas-types/testing/queued-graph-fetch';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { OneDriveDeltaItem } from '@wisecom/atlas-types';

/**
 * The behaviour issue #246 introduces: a 403 is acted on for the reason it was
 * returned, instead of every 403 being read as a stale pre-authenticated URL.
 *
 * The suite in download-helpers.test.ts pins the routing. This one asserts what the
 * download path *does* with each classification, which is where the reported symptom
 * lived: a missing grant became a per-file retry storm reported as a skipped file.
 *
 * The URL download is the real shared one, driven through `fetch`, so a Graph-shaped
 * error arrives only when the fetch itself rejects with one (issue #675).
 */

const mocks = vi.hoisted(() => ({
  download_file_chunked: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/adapters/graph-onedrive-chunk-downloader', () => ({
  ONEDRIVE_CHUNK_DOWNLOADER: {
    download_file_chunked: mocks.download_file_chunked,
    fetch_file_chunks: vi.fn(),
  },
}));

vi.mock('@wisecom/atlas-m365-graph', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, with_graph_retry: (fn: () => unknown) => fn() };
});

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: mocks.warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { ONEDRIVE_DOWNLOAD_EXECUTOR } = await import('@/adapters/graph-onedrive-download-executor');
const { download_with_fallback } = ONEDRIVE_DOWNLOAD_EXECUTOR;

const STALE_URL = 'https://cdn.example.invalid/stale';
const CONTENT_BODY = Buffer.from('graph-content');

/** A Graph error as the SDK surfaces it: statusCode plus a machine-readable code. */
function graph_error(status: number, code: string): { statusCode: number; code: string } {
  return { statusCode: status, code };
}

/** Minimal fetch Response stand-in: only the fields the URL download reads. */
function make_response(status: number, body = Buffer.alloc(0)): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    // Node pools small Buffers, so the view's byteOffset is not necessarily 0.
    arrayBuffer: () =>
      Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
  } as unknown as Response;
}

interface GraphClientMock {
  client: Client;
  api: Mock;
  get: Mock;
  get_stream: Mock;
}

function make_client(): GraphClientMock {
  const get = vi.fn().mockResolvedValue({ '@microsoft.graph.downloadUrl': 'https://fresh' });
  const get_stream = vi.fn(() => Promise.resolve(binary_graph_response(CONTENT_BODY)));
  const select = vi.fn(() => ({ get }));
  const api = vi.fn(() => ({ select, get, responseType: () => ({ get: get_stream }) }));
  const client = { api } as unknown as Client;
  return { client, api, get, get_stream };
}

/**
 * `size_bytes` is 0, which `assert_transferred_size` reads as "no recorded size" and skips.
 * These cases are about how a 403 is classified, not about transfer length (issue #368).
 */
function make_item(): OneDriveDeltaItem {
  return {
    drive_id: 'drive-1',
    item_id: 'item-1',
    kind: 'file',
    file_name: 'Report.docx',
    parent_path: '/',
    size_bytes: 0,
    deleted: false,
    download_url: STALE_URL,
  };
}

describe('OneDrive 403 handling by cause (issue #246)', () => {
  let fetch_mock: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    fetch_mock = vi.fn();
    vi.stubGlobal('fetch', fetch_mock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails fast on a missing grant, without re-resolving and without a /content fallback', async () => {
    const mock = make_client();
    fetch_mock.mockRejectedValue(graph_error(403, 'accessDenied'));

    await expect(download_with_fallback(mock.client, make_item())).rejects.toThrow(
      'Missing Microsoft Graph application permissions for OneDrive: Files.Read.All, Sites.Read.All.',
    );

    // The whole point of the fix: neither budget is spent.
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.get_stream).not.toHaveBeenCalled();
    expect(fetch_mock).toHaveBeenCalledOnce();
  });

  it('records a service refusal against the item, naming the code, without a fallback', async () => {
    const mock = make_client();
    fetch_mock.mockRejectedValue(graph_error(403, 'notAllowed'));

    const error = await download_with_fallback(mock.client, make_item()).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(DownloadRefusedError);
    expect((error as DownloadRefusedError).graph_code).toBe('notAllowed');
    expect((error as Error).message).toContain('Report.docx');
    expect((error as Error).message).toContain('not a transient failure');
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.get_stream).not.toHaveBeenCalled();
  });

  it('treats an unrecognised 403 code as a per-item refusal rather than aborting the run', async () => {
    const mock = make_client();
    fetch_mock.mockRejectedValue(graph_error(403, 'someFutureCode'));

    const error = await download_with_fallback(mock.client, make_item()).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(DownloadRefusedError);
    expect((error as DownloadRefusedError).graph_code).toBe('someFutureCode');
  });

  it('still re-resolves and retries a genuinely expired CDN URL', async () => {
    const mock = make_client();
    const body = Buffer.from('after-refresh');
    fetch_mock
      .mockResolvedValueOnce(make_response(403))
      .mockResolvedValueOnce(make_response(200, body));

    await expect(download_with_fallback(mock.client, make_item())).resolves.toEqual(body);
    expect(mock.get).toHaveBeenCalledOnce();
    expect(fetch_mock).toHaveBeenNthCalledWith(2, 'https://fresh', expect.anything());
    expect(mock.get_stream).not.toHaveBeenCalled();
  });

  it('falls back to /content for a Graph 401, which a URL refresh cannot fix', async () => {
    const mock = make_client();
    fetch_mock.mockRejectedValue(graph_error(401, 'unauthenticated'));

    await expect(download_with_fallback(mock.client, make_item())).resolves.toEqual(CONTENT_BODY);
    expect(classify_download_failure(graph_error(401, 'unauthenticated'))).toBe('unauthorized');
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.get_stream).toHaveBeenCalledOnce();
  });

  it('no longer sends a wrapped storage error down the expired-URL path', async () => {
    const mock = make_client();
    fetch_mock.mockRejectedValue(new Error('S3 GetObject failed: Forbidden'));

    await expect(download_with_fallback(mock.client, make_item())).resolves.toEqual(CONTENT_BODY);
    // Before #246 the substring match re-resolved the URL for this error.
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.get_stream).toHaveBeenCalledOnce();
  });
});
