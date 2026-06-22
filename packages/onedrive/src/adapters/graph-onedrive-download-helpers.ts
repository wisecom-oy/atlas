import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
import {
  CdnHttpError,
  CHUNK_DOWNLOAD_THRESHOLD,
  compute_chunk_timeout_ms,
  download_file_chunked,
} from '@/adapters/graph-onedrive-chunked-download';
import {
  download_from_url,
  stream_to_buffer,
  with_timeout,
} from '@/adapters/graph-onedrive-connector-stream';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { Client } from '@microsoft/microsoft-graph-client';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';

interface GraphDriveItemDownload {
  '@microsoft.graph.downloadUrl'?: string;
}

/** Resolves the temporary pre-authenticated download URL for a file via Graph. */
export async function resolve_download_url(
  client: Client,
  item: OneDriveDeltaItem,
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

/** Runs a download attempt with expired-URL refresh and Graph content fallback. */
async function attempt_download_with_refresh(
  client: Client,
  item: OneDriveDeltaItem,
  download_url: string | undefined,
  download_fn: (url: string) => Promise<Buffer>,
  strategy_label: string,
): Promise<Buffer> {
  if (!download_url) {
    return download_via_graph_content(client, item);
  }

  try {
    return await download_fn(download_url);
  } catch (err) {
    if (is_expired_url_error(err)) {
      const refreshed_url = await resolve_download_url(client, item);
      if (refreshed_url) {
        try {
          return await download_fn(refreshed_url);
        } catch (retry_err) {
          logger.warn(`${strategy_label} retry failed for ${item.item_id}: ${retry_err}`);
        }
      }
    } else {
      logger.warn(`${strategy_label} failed for ${item.item_id}, falling back: ${err}`);
    }
    return download_via_graph_content(client, item);
  }
}

/** Downloads file content with expired-URL refresh and Graph content fallback. */
export async function download_with_fallback(
  client: Client,
  item: OneDriveDeltaItem,
): Promise<Buffer> {
  const download_url = item.download_url ?? (await resolve_download_url(client, item));

  if (download_url && item.size_bytes > CHUNK_DOWNLOAD_THRESHOLD) {
    return attempt_download_with_refresh(
      client,
      item,
      download_url,
      (url) => download_file_chunked(url, item.size_bytes, item.item_id),
      'Chunked download',
    );
  }

  return attempt_download_with_refresh(
    client,
    item,
    download_url,
    (url) => download_from_url(url, item.size_bytes, item.item_id),
    'URL download',
  );
}

/** Downloads via the Graph /content endpoint with stream drain. */
export async function download_via_graph_content(
  client: Client,
  item: OneDriveDeltaItem,
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
  const drain_timeout_ms = compute_chunk_timeout_ms(item.size_bytes) * 2;
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
  throw_missing_permissions('read');
}

export function throw_missing_permissions(context: 'read' | 'write' = 'read'): never {
  const read_perms = 'Files.Read.All, Sites.Read.All';
  const write_perms = 'Files.ReadWrite.All, Sites.Read.All';
  const perms = context === 'write' ? write_perms : read_perms;
  throw new Error(`Missing Microsoft Graph application permissions for OneDrive: ${perms}.`);
}
