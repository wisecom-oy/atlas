import { classify_download_failure, DownloadRefusedError } from '@wisecom/atlas-m365-graph';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';
import { Readable } from 'node:stream';

/**
 * The SharePoint half of issue #246, asserted separately from the OneDrive half
 * because the two download paths are not the same code: SharePoint's
 * `download_from_url` is private and driven by `fetch`, so a Graph-shaped 403 has to
 * be injected differently. The observable behaviour must match the twin, and these
 * assertions are what proves it does.
 */

const mocks = vi.hoisted(() => ({
  download_file_chunked: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/adapters/graph-sharepoint-chunked-download', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, download_file_chunked: mocks.download_file_chunked };
});

vi.mock('@wisecom/atlas-m365-graph', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, with_graph_retry: (fn: () => unknown) => fn() };
});

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: mocks.warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { download_with_fallback } = await import('@/adapters/graph-sharepoint-download-helpers');

const STALE_URL = 'https://cdn.example.invalid/stale';
const CONTENT_BODY = Buffer.from('graph-content');

/**
 * SharePoint reaches the URL through `fetch`, so a Graph-shaped error (statusCode
 * plus code) arrives only when the fetch itself rejects with one, which is what a
 * wrapped Graph failure looks like on this path.
 */
function graph_error(status: number, code: string): { statusCode: number; code: string } {
  return { statusCode: status, code };
}

interface GraphClientMock {
  client: Client;
  api: Mock;
  get: Mock;
  get_stream: Mock;
}

function make_client(): GraphClientMock {
  const get = vi.fn().mockResolvedValue({ '@microsoft.graph.downloadUrl': 'https://fresh' });
  const get_stream = vi.fn().mockResolvedValue(Readable.from([CONTENT_BODY]));
  const select = vi.fn(() => ({ get }));
  const api = vi.fn(() => ({ select, get, getStream: get_stream }));
  const client = { api } as unknown as Client;
  return { client, api, get, get_stream };
}

function make_item(): SharePointDeltaItem {
  return {
    drive_id: 'drive-1',
    item_id: 'item-1',
    kind: 'file',
    file_name: 'Budget.xlsx',
    parent_path: '/',
    size_bytes: 1024,
    deleted: false,
    download_url: STALE_URL,
  };
}

describe('SharePoint 403 handling by cause (issue #246)', () => {
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
      'Missing Microsoft Graph application permissions for SharePoint: Sites.Read.All.',
    );

    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.get_stream).not.toHaveBeenCalled();
  });

  it('records a service refusal against the item, naming the code, without a fallback', async () => {
    const mock = make_client();
    fetch_mock.mockRejectedValue(graph_error(403, 'notAllowed'));

    const error = await download_with_fallback(mock.client, make_item()).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(DownloadRefusedError);
    expect((error as DownloadRefusedError).graph_code).toBe('notAllowed');
    expect((error as Error).message).toContain('Budget.xlsx');
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
    const body = Buffer.from('after-refresh');
    const mock = make_client();
    // A 403 from the CDN itself, which is what an expired pre-authenticated URL
    // returns, and the one case worth re-resolving.
    fetch_mock
      .mockResolvedValueOnce({ status: 403, ok: false, headers: new Headers() })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers(),
        // Node pools small Buffers, so the view's byteOffset is not necessarily 0.
        arrayBuffer: () =>
          Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
      });

    await expect(download_with_fallback(mock.client, make_item())).resolves.toEqual(body);
    expect(mock.get).toHaveBeenCalledOnce();
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
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.get_stream).toHaveBeenCalledOnce();
  });
});
