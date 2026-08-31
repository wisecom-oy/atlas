import { classify_download_failure, DownloadRefusedError } from '@wisecom/atlas-m365-graph';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
// Static: vi.mock is hoisted above imports, and the partial mock keeps CdnHttpError real.
import { CdnHttpError } from '@/adapters/graph-onedrive-chunked-download';

/**
 * The behaviour issue #246 introduces: a 403 is acted on for the reason it was
 * returned, instead of every 403 being read as a stale pre-authenticated URL.
 *
 * The suite in download-helpers.test.ts pins the classification itself. This one
 * asserts what the download path *does* with each classification, which is where the
 * reported symptom lived: a missing grant became a per-file retry storm reported as a
 * skipped file.
 */

const mocks = vi.hoisted(() => ({
  download_file_chunked: vi.fn(),
  download_from_url: vi.fn(),
  stream_to_buffer: vi.fn(),
  with_timeout: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/adapters/graph-onedrive-chunked-download', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, download_file_chunked: mocks.download_file_chunked };
});

vi.mock('@/adapters/graph-onedrive-connector-stream', () => ({
  download_from_url: mocks.download_from_url,
  stream_to_buffer: mocks.stream_to_buffer,
  with_timeout: mocks.with_timeout,
}));

vi.mock('@wisecom/atlas-m365-graph', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, with_graph_retry: (fn: () => unknown) => fn() };
});

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: mocks.warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { download_with_fallback } = await import('@/adapters/graph-onedrive-download-helpers');

const STALE_URL = 'https://cdn.example.invalid/stale';
const CONTENT_BODY = Buffer.from('graph-content');

/** A Graph error as the SDK surfaces it: statusCode plus a machine-readable code. */
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
  const get_stream = vi.fn().mockResolvedValue('stream-handle');
  const select = vi.fn(() => ({ get }));
  const api = vi.fn(() => ({ select, get, getStream: get_stream }));
  const client = { api } as unknown as Client;
  return { client, api, get, get_stream };
}
function make_item(): OneDriveDeltaItem {
  return {
    drive_id: 'drive-1',
    item_id: 'item-1',
    kind: 'file',
    file_name: 'Report.docx',
    parent_path: '/',
    size_bytes: 1024,
    deleted: false,
    download_url: STALE_URL,
  };
}

describe('OneDrive 403 handling by cause (issue #246)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stream_to_buffer.mockResolvedValue(CONTENT_BODY);
    mocks.with_timeout.mockImplementation((promise: Promise<unknown>) => promise);
  });

  it('fails fast on a missing grant, without re-resolving and without a /content fallback', async () => {
    const mock = make_client();
    mocks.download_from_url.mockRejectedValue(graph_error(403, 'accessDenied'));

    await expect(download_with_fallback(mock.client, make_item())).rejects.toThrow(
      'Missing Microsoft Graph application permissions for OneDrive: Files.Read.All, Sites.Read.All.',
    );

    // The whole point of the fix: neither budget is spent.
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.get_stream).not.toHaveBeenCalled();
    expect(mocks.download_from_url).toHaveBeenCalledOnce();
  });

  it('records a service refusal against the item, naming the code, without a fallback', async () => {
    const mock = make_client();
    mocks.download_from_url.mockRejectedValue(graph_error(403, 'notAllowed'));

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
    mocks.download_from_url.mockRejectedValue(graph_error(403, 'someFutureCode'));

    const error = await download_with_fallback(mock.client, make_item()).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(DownloadRefusedError);
    expect((error as DownloadRefusedError).graph_code).toBe('someFutureCode');
  });

  it('still re-resolves and retries a genuinely expired CDN URL', async () => {
    const mock = make_client();
    const body = Buffer.from('after-refresh');
    mocks.download_from_url
      .mockRejectedValueOnce(new CdnHttpError('expired', 403))
      .mockResolvedValueOnce(body);

    await expect(download_with_fallback(mock.client, make_item())).resolves.toEqual(body);
    expect(mock.get).toHaveBeenCalledOnce();
    expect(mock.get_stream).not.toHaveBeenCalled();
  });

  it('falls back to /content for a Graph 401, which a URL refresh cannot fix', async () => {
    const mock = make_client();
    mocks.download_from_url.mockRejectedValue(graph_error(401, 'unauthenticated'));

    await expect(download_with_fallback(mock.client, make_item())).resolves.toEqual(CONTENT_BODY);
    expect(classify_download_failure(graph_error(401, 'unauthenticated'))).toBe('unauthorized');
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.get_stream).toHaveBeenCalledOnce();
  });

  it('no longer sends a wrapped storage error down the expired-URL path', async () => {
    const mock = make_client();
    mocks.download_from_url.mockRejectedValue(new Error('S3 GetObject failed: Forbidden'));

    await expect(download_with_fallback(mock.client, make_item())).resolves.toEqual(CONTENT_BODY);
    // Before #246 the substring match re-resolved the URL for this error.
    expect(mock.get).not.toHaveBeenCalled();
    expect(mock.get_stream).toHaveBeenCalledOnce();
  });
});
