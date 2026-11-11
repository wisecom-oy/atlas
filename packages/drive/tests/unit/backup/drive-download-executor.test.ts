import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { classify_download_failure } from '@wisecom/atlas-m365-graph';
import type { CdnChunkDownloader } from '@/backup/cdn-chunk-download';
import { CdnHttpError } from '@/backup/cdn-chunk-errors';
import {
  create_drive_download_executor,
  is_expired_url_error,
  type DriveDownloadBinding,
} from '@/backup/drive-download-executor';
import type { DriveDownloadItem, DriveGraphClient } from '@/backup/graph-item-content';

vi.mock('@wisecom/atlas-m365-graph', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, with_graph_retry: (fn: () => unknown) => fn() };
});

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const STALE_URL = 'https://cdn.example.invalid/stale';
const FRESH_URL = 'https://cdn.example.invalid/fresh';
const BODY = Buffer.from('file-body');

const CHUNK_DOWNLOADER: CdnChunkDownloader = {
  fetch_file_chunks: vi.fn(),
  download_file_chunked: vi.fn(),
};

const BINDINGS: readonly [string, DriveDownloadBinding][] = [
  [
    'OneDrive',
    {
      workload: 'onedrive',
      read_permissions: 'Files.Read.All, Sites.Read.All',
      chunk_downloader: CHUNK_DOWNLOADER,
    },
  ],
  [
    'SharePoint',
    {
      workload: 'sharepoint',
      read_permissions: 'Sites.Read.All',
      chunk_downloader: CHUNK_DOWNLOADER,
    },
  ],
];

function respond(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    arrayBuffer: () =>
      Promise.resolve(BODY.buffer.slice(BODY.byteOffset, BODY.byteOffset + BODY.byteLength)),
  } as unknown as Response;
}

function make_client(content: NodeJS.ReadableStream = Readable.from([BODY])): {
  client: DriveGraphClient;
  get_stream: Mock;
} {
  const get = vi.fn().mockResolvedValue({ '@microsoft.graph.downloadUrl': FRESH_URL });
  const get_stream = vi.fn().mockResolvedValue(content);
  const api = vi.fn(() => ({ select: () => ({ get }), get, getStream: get_stream }));
  return { client: { api } as unknown as DriveGraphClient, get_stream };
}

const ITEM: DriveDownloadItem = {
  drive_id: 'drive-1',
  item_id: 'item-1',
  file_name: 'file.bin',
  size_bytes: BODY.length,
  download_url: STALE_URL,
};

describe.each(BINDINGS)('shared download executor bound to %s', (label, binding) => {
  const executor = create_drive_download_executor(binding);
  let fetch_mock: Mock;

  beforeEach(() => {
    fetch_mock = vi.fn();
    vi.stubGlobal('fetch', fetch_mock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('re-resolves a stale URL and downloads from the fresh one', async () => {
    fetch_mock.mockResolvedValueOnce(respond(403)).mockResolvedValueOnce(respond(200));

    await expect(executor.download_with_fallback(make_client().client, ITEM)).resolves.toEqual(
      BODY,
    );
    expect(fetch_mock).toHaveBeenNthCalledWith(2, FRESH_URL, expect.anything());
  });

  it('names the workload and its permissions on a missing grant', () => {
    expect(() => executor.rethrow_if_access_denied({ statusCode: 403 })).toThrow(
      `Missing Microsoft Graph application permissions for ${label}: ${binding.read_permissions}.`,
    );
  });

  // Issue #676: an errored /content drain must not leave its drain timer behind.
  it('leaves no timer behind when the /content stream errors', async () => {
    vi.useFakeTimers();
    fetch_mock.mockResolvedValue(respond(500));
    // Errors on the first read, so the failure lands inside the drain.
    const content = new Readable({
      read(): void {
        this.destroy(new Error('stream reset'));
      },
    });

    const outcome = await executor
      .download_with_fallback(make_client(content).client, ITEM)
      .catch((err: unknown) => err);

    expect(outcome).toEqual(new Error('stream reset'));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('is_expired_url_error', () => {
  it.each([401, 403])('treats CdnHttpError %i as an expired URL', (status) => {
    expect(is_expired_url_error(new CdnHttpError('denied', status))).toBe(true);
  });

  it.each([404, 429, 500])('does not treat CdnHttpError %i as an expired URL', (status) => {
    expect(is_expired_url_error(new CdnHttpError('other', status))).toBe(false);
  });

  // A Graph 401 is a credential problem and a Graph 403 a missing grant or a refusal (#246).
  it.each([401, 403])('does not treat a Graph error with statusCode %i as expired', (status) => {
    expect(is_expired_url_error({ statusCode: status })).toBe(false);
  });

  it('classifies a Graph 401 separately from a Graph 403', () => {
    expect(classify_download_failure({ statusCode: 401 })).toBe('unauthorized');
    expect(classify_download_failure({ statusCode: 403, code: 'accessDenied' })).toBe(
      'missing_permission',
    );
    expect(classify_download_failure({ statusCode: 403, code: 'notAllowed' })).toBe(
      'service_refused',
    );
  });

  // `message` can change at any time; only the status and code are read (#246).
  it.each(['Forbidden', 'Unauthorized'])('ignores a message-only error containing %s', (word) => {
    expect(is_expired_url_error(new Error(`S3 GetObject failed: ${word}`))).toBe(false);
  });

  it.each([undefined, null, 0, 'plain string'])('classifies %s without crashing', (value) => {
    expect(is_expired_url_error(value)).toBe(false);
  });
});
