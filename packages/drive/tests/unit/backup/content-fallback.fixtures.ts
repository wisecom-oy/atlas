/** A Graph client stand-in and download connectors for the `/content` fallback suites. */

import { vi, type Mock } from 'vitest';
import type { CdnChunkDownloader } from '@/backup/cdn-chunk-download';
import {
  create_drive_download_executor,
  type DriveDownloadBinding,
} from '@/backup/drive-download-executor';
import type { DriveGraphClient } from '@/backup/graph-item-content';
import type { DriveDownloadUrlResolver } from '@/backup/large-file-pipeline';
import type { DriveContentConnector, DriveDeltaItem } from '@/drive-ports';

/** How the stand-in answers one `/content` request, given the signal the request was sent with. */
export type ContentAnswer = (signal: AbortSignal) => Promise<Response>;

export interface ContentClientRig {
  readonly client: DriveGraphClient;
  /** The signal each `/content` request was sent with, in the order they were sent. */
  readonly request_signals: AbortSignal[];
  /** Called once per `/content` request. */
  readonly content_requests: Mock<ContentAnswer>;
  /** Called once per download-URL lookup. */
  readonly url_lookups: Mock<() => Promise<unknown>>;
}

/**
 * A client whose download-URL lookup answers `url_lookup` and whose `/content` requests answer
 * `content`. Each request records the signal it was handed through `.option('signal', ...)`.
 */
export function content_client_rig(
  content: ContentAnswer,
  url_lookup: () => Promise<unknown> = () => Promise.resolve({}),
): ContentClientRig {
  const request_signals: AbortSignal[] = [];
  const content_requests = vi.fn(content);
  const url_lookups = vi.fn(url_lookup);
  const api = (): unknown => {
    let signal = new AbortController().signal;
    const request = {
      select: () => ({ get: url_lookups }),
      get: url_lookups,
      option: (key: string, value: unknown) => {
        if (key === 'signal') signal = value as AbortSignal;
        return request;
      },
      responseType: () => ({
        get: () => {
          request_signals.push(signal);
          return content_requests(signal);
        },
      }),
    };
    return request;
  };
  return {
    client: { api } as unknown as DriveGraphClient,
    request_signals,
    content_requests,
    url_lookups,
  };
}

/** A request that never answers, and fails with the abort reason once its signal fires, as fetch does. */
export function stalled_request(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

/** A 200 whose body never delivers a byte. */
export function stalled_body_response(): Response {
  return new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }));
}

/** A Graph JSON error answer with `status`, as `/content` relays it from the download host. */
export function graph_status_response(status: number, headers: Record<string, string> = {}) {
  const body = JSON.stringify({ error: { code: 'error', message: `HTTP ${status}` } });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** A chunk downloader whose chunked download is the given mock. */
export function chunk_downloader(download_file_chunked: Mock): CdnChunkDownloader {
  return { download_file_chunked, fetch_file_chunks: vi.fn() };
}

/** The OneDrive and SharePoint bindings of the shared executor, with `chunks` as their downloader. */
export function drive_bindings(chunks: CdnChunkDownloader): [string, DriveDownloadBinding][] {
  return [
    [
      'OneDrive',
      {
        workload: 'onedrive',
        read_permissions: ['Files.Read.All', 'Sites.Read.All'],
        chunk_downloader: chunks,
      },
    ],
    [
      'SharePoint',
      { workload: 'sharepoint', read_permissions: ['Sites.Read.All'], chunk_downloader: chunks },
    ],
  ];
}

/** A connector whose download and URL lookup go through the shared executor bound to `binding`. */
export function executor_connector(
  binding: DriveDownloadBinding,
  client: DriveGraphClient,
): DriveContentConnector & DriveDownloadUrlResolver {
  const executor = create_drive_download_executor(binding);
  // Only the two calls the file download makes; the version calls are never reached.
  const connector: Pick<DriveContentConnector, 'download_file_content'> & DriveDownloadUrlResolver =
    {
      download_file_content: (item, abort_signal) =>
        executor.download_with_fallback(client, item, abort_signal),
      resolve_download_url: (item) => executor.resolve_download_url(client, item),
    };
  return connector as DriveContentConnector & DriveDownloadUrlResolver;
}

/** A drive file of `size_bytes`, with the download URL from the listing when one is given. */
export function drive_file(size_bytes: number, download_url?: string): DriveDeltaItem {
  return {
    drive_id: 'drive-1',
    item_id: 'item-1',
    kind: 'file',
    file_name: 'report.docx',
    parent_path: '/',
    size_bytes,
    deleted: false,
    ...(download_url === undefined ? {} : { download_url }),
  } as DriveDeltaItem;
}
