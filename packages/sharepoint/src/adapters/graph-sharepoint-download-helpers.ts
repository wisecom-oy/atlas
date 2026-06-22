import { logger } from '@wisecom/atlas-core/utils/logger';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';
import type { Client } from '@microsoft/microsoft-graph-client';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import {
  CdnHttpError,
  CHUNK_DOWNLOAD_THRESHOLD,
  compute_chunk_timeout_ms,
  download_file_chunked,
} from '@/adapters/graph-sharepoint-chunked-download';

interface GraphDriveItemDownload {
  '@microsoft.graph.downloadUrl'?: string;
}

const MAX_URL_RETRIES = 3;

/** Resolves the temporary pre-authenticated download URL for a file via Graph. */
export async function resolve_download_url(
  client: Client,
  item: SharePointDeltaItem,
): Promise<string | undefined> {
  const response = await with_graph_retry(
    () =>
      client
        .api(`/drives/${item.drive_id}/items/${item.item_id}`)
        .select('@microsoft.graph.downloadUrl')
        .get() as Promise<GraphDriveItemDownload>,
  );
  return response['@microsoft.graph.downloadUrl'];
}

/** Downloads file content with chunked download, expired-URL refresh, and Graph fallback. */
export async function download_with_fallback(
  client: Client,
  item: SharePointDeltaItem,
): Promise<Buffer> {
  const download_url = item.download_url ?? (await resolve_download_url(client, item));

  if (download_url && item.size_bytes > CHUNK_DOWNLOAD_THRESHOLD) {
    return await attempt_download_with_refresh(
      client,
      item,
      download_url,
      (url) => download_file_chunked(url, item.size_bytes, item.item_id),
      'Chunked download',
    );
  }

  if (download_url) {
    return await attempt_download_with_refresh(
      client,
      item,
      download_url,
      (url) => download_from_url(url, item.size_bytes, item.item_id),
      'URL download',
    );
  }

  return await download_via_graph_content(client, item);
}

/** Attempts a CDN download, refreshing expired URLs once before falling back to Graph. */
async function attempt_download_with_refresh(
  client: Client,
  item: SharePointDeltaItem,
  download_url: string,
  download_fn: (url: string) => Promise<Buffer>,
  failure_label: string,
): Promise<Buffer> {
  try {
    return await download_fn(download_url);
  } catch (err) {
    if (is_expired_url_error(err)) {
      const refreshed_url = await resolve_download_url(client, item);
      if (refreshed_url) {
        try {
          return await download_fn(refreshed_url);
        } catch (retry_err) {
          logger.warn(`${failure_label} retry failed for ${item.item_id}: ${retry_err}`);
        }
      }
    } else {
      logger.warn(`${failure_label} failed for ${item.item_id}, falling back: ${err}`);
    }
    return await download_via_graph_content(client, item);
  }
}

/** Downloads via the Graph /content endpoint with stream drain. */
export async function download_via_graph_content(
  client: Client,
  item: SharePointDeltaItem,
): Promise<Buffer> {
  const stream_timeout_ms = compute_chunk_timeout_ms(item.size_bytes);
  const stream = await with_timeout(
    with_graph_retry(
      () =>
        client
          .api(`/drives/${item.drive_id}/items/${item.item_id}/content`)
          .getStream() as Promise<NodeJS.ReadableStream>,
    ),
    stream_timeout_ms,
    `Graph content request timed out for file ${item.item_id}`,
  );
  const drain_timeout_ms = stream_timeout_ms * 2;
  return await stream_to_buffer(stream, drain_timeout_ms);
}

export function is_expired_url_error(err: unknown): boolean {
  if (err instanceof CdnHttpError) {
    return err.status_code === 401 || err.status_code === 403;
  }
  const graph_status = (err as { statusCode?: number }).statusCode;
  if (typeof graph_status === 'number') return graph_status === 401 || graph_status === 403;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('Forbidden') || message.includes('Unauthorized');
}

export function rethrow_if_access_denied(err: unknown): void {
  const graph_err = err as Record<string, unknown>;
  if (graph_err.statusCode !== 403) return;
  throw new Error(
    'Missing Microsoft Graph application permissions for SharePoint: Sites.Read.All.',
  );
}

async function download_from_url(
  download_url: string,
  size_bytes: number,
  item_id: string,
): Promise<Buffer> {
  const timeout_ms = compute_chunk_timeout_ms(size_bytes);

  for (let attempt = 0; attempt <= MAX_URL_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms);
    try {
      const response = await fetch(download_url, { signal: controller.signal });

      if (response.status === 429) {
        const retry_after = parse_retry_after(response.headers.get('Retry-After'));
        if (attempt < MAX_URL_RETRIES) {
          const delay = retry_after ?? 1_000 * 2 ** attempt;
          logger.debug(`HTTP 429 downloading ${item_id}, retry in ${delay}ms`);
          await sleep_ms(delay);
          continue;
        }
        throw new CdnHttpError(`HTTP 429 downloading ${item_id}`, 429, retry_after);
      }

      if (!response.ok) {
        throw new CdnHttpError(
          `Failed to download SharePoint file ${item_id}: HTTP ${response.status}`,
          response.status,
        );
      }

      return Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`download_from_url: exhausted retries for ${item_id}`);
}

function with_timeout<T>(promise: Promise<T>, timeout_ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout_ms);
    }),
  ]);
}

function stream_to_buffer(stream: NodeJS.ReadableStream, timeout_ms: number): Promise<Buffer> {
  const readable = stream as import('node:stream').Readable;
  const chunks: Buffer[] = [];
  const read_stream = async (): Promise<void> => {
    for await (const chunk of readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  };
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    read_stream().then(() => {
      if (timer) clearTimeout(timer);
      return Buffer.concat(chunks);
    }),
    new Promise<Buffer>((_, reject) => {
      timer = setTimeout(() => {
        readable.destroy();
        reject(new Error('Graph content stream timed out'));
      }, timeout_ms);
    }),
  ]);
}

function parse_retry_after(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = parseInt(value, 10);
  return isNaN(seconds) ? undefined : seconds * 1000;
}

function sleep_ms(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
