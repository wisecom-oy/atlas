import { DownloadRefusedError, MissingGraphPermissionsError } from '@wisecom/atlas-m365-graph';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { binary_graph_response } from '@wisecom/atlas-types/testing/queued-graph-fetch';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';

/**
 * Issue #632: the chunked path rethrew a failed chunk as a plain `Error`, so the download executor
 * classified every chunked failure as `unclassified`. An expired URL was never re-resolved and a
 * 403 refusal reached `/content` as a raw Graph error. `download-403-classification.test.ts` mocks
 * the chunked download away, so these drive the real downloader through `fetch`.
 */

vi.mock('@wisecom/atlas-m365-graph', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, with_graph_retry: (fn: () => unknown) => fn() };
});

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { SHAREPOINT_DOWNLOAD_EXECUTOR } =
  await import('@/adapters/graph-sharepoint-download-executor');
const { download_with_fallback } = SHAREPOINT_DOWNLOAD_EXECUTOR;

const STALE_URL = 'https://cdn.example.invalid/stale';
const FRESH_URL = 'https://cdn.example.invalid/fresh';
/** Two 4 MiB chunks, so the file is above the chunked-download threshold. */
const SIZE = 4 * 1024 * 1024 + 1024;

interface GraphClientMock {
  client: Client;
  get: Mock;
  get_stream: Mock;
}

function make_client(): GraphClientMock {
  const get = vi.fn().mockResolvedValue({ '@microsoft.graph.downloadUrl': FRESH_URL });
  const get_stream = vi.fn(() => Promise.resolve(binary_graph_response(Buffer.alloc(SIZE, 2))));
  const select = vi.fn(() => ({ get }));
  const api = vi.fn(() => ({ select, get, responseType: () => ({ get: get_stream }) }));
  return { client: { api } as unknown as Client, get, get_stream };
}

function make_item(): SharePointDeltaItem {
  return {
    drive_id: 'drive-1',
    item_id: 'item-1',
    kind: 'file',
    file_name: 'report.bin',
    parent_path: '/',
    size_bytes: SIZE,
    deleted: false,
    download_url: STALE_URL,
  };
}

/** A 206 for exactly the requested range. */
function honest_range(init: { headers: Record<string, string> }): Response {
  const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers['Range'] ?? '')!;
  const body = Buffer.alloc(Number(end) - Number(start) + 1, 1);
  return new Response(body, {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/${SIZE}` },
  });
}

describe('SharePoint chunked download failure handling (issue #632)', () => {
  let fetch_mock: Mock;

  beforeEach(() => {
    fetch_mock = vi.fn();
    vi.stubGlobal('fetch', fetch_mock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('re-resolves an expired URL and resumes the chunked download from the fresh one', async () => {
    const mock = make_client();
    fetch_mock.mockImplementation((url: string, init: { headers: Record<string, string> }) =>
      Promise.resolve(url === STALE_URL ? new Response(null, { status: 403 }) : honest_range(init)),
    );

    const body = await download_with_fallback(mock.client, make_item());

    expect(body.length).toBe(SIZE);
    expect(mock.get).toHaveBeenCalledOnce();
    expect(fetch_mock.mock.calls.map((call) => call[0])).toEqual([STALE_URL, FRESH_URL, FRESH_URL]);
    expect(mock.get_stream).not.toHaveBeenCalled();
  });

  it('records a 403 service refusal as DownloadRefusedError, without a /content fallback', async () => {
    const mock = make_client();
    fetch_mock.mockRejectedValue({ statusCode: 403, code: 'notAllowed' });

    const error = await download_with_fallback(mock.client, make_item()).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(DownloadRefusedError);
    expect((error as DownloadRefusedError).graph_code).toBe('notAllowed');
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.get_stream).not.toHaveBeenCalled();
  });

  it('stops the run on a missing grant, without a /content fallback', async () => {
    const mock = make_client();
    fetch_mock.mockRejectedValue({ statusCode: 403, code: 'accessDenied' });

    await expect(download_with_fallback(mock.client, make_item())).rejects.toBeInstanceOf(
      MissingGraphPermissionsError,
    );
    expect(mock.get_stream).not.toHaveBeenCalled();
  });

  it('stops at once when cancelled during a chunk backoff, with no refresh and no fallback', async () => {
    vi.useFakeTimers();
    const mock = make_client();
    fetch_mock.mockResolvedValue(new Response(null, { status: 503 }));
    const cancel = new AbortController();

    const outcome = download_with_fallback(mock.client, make_item(), cancel.signal).catch(
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(100);
    cancel.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(0);

    expect(((await outcome) as Error).message).toBe('Run interrupted by Ctrl+C');
    expect(fetch_mock).toHaveBeenCalledOnce();
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.get_stream).not.toHaveBeenCalled();
  });
});
