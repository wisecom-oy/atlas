import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
import {
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
import type { DownloadFailureKind } from '@wisecom/atlas-m365-graph';
import {
  with_graph_retry,
  classify_download_failure,
  read_graph_error_code,
  DownloadRefusedError,
  MissingGraphPermissionsError,
} from '@wisecom/atlas-m365-graph';

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

/**
 * Throws for the two 403 causes that neither a URL refresh nor the `/content`
 * fallback can resolve, so the caller stops instead of spending a second retry
 * budget on a refusal (issue #246).
 */
function rethrow_if_unrecoverable(
  kind: DownloadFailureKind,
  err: unknown,
  item: OneDriveDeltaItem,
): void {
  // A missing grant answers 403 on every item, so the run must stop and name it.
  if (kind === 'missing_permission') {
    throw_missing_permissions('read');
  }

  // The service will keep refusing this item, so it is recorded against the
  // snapshot with the code that explains it, rather than retried.
  if (kind === 'service_refused') {
    const code = read_graph_error_code(err);
    throw new DownloadRefusedError(
      `Microsoft 365 refused to release ${item.file_name} (${item.item_id}): ` +
        `Graph returned 403 ${code}. This is a protection or policy state on the ` +
        `item, not a transient failure.`,
      code,
    );
  }
}

/**
 * Runs a download attempt, acting on the cause of a failure rather than assuming
 * every 403 is a stale URL (issue #246).
 */
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
    const kind = classify_download_failure(err);
    rethrow_if_unrecoverable(kind, err, item);

    if (kind === 'expired_url') {
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

/**
 * True only for a stale pre-authenticated URL, which is the one 403 worth retrying.
 *
 * Delegates to the shared classifier so both drives cannot drift, and so a nullish
 * rejection reason is classified instead of crashing the classifier (issue #263).
 */
export function is_expired_url_error(err: unknown): boolean {
  return classify_download_failure(err) === 'expired_url';
}

/**
 * Rethrows any Graph 403 as a missing grant.
 *
 * Deliberately broader than the download-path classification. Its callers are the
 * enumeration paths (`list_drives`, `fetch_delta`), where a 403 has one plausible
 * cause: there is no per-item protection state when listing a drive. The finer
 * split between a missing grant and a service refusal belongs to the download
 * path, where both are reachable for the same item (issue #246).
 */
export function rethrow_if_access_denied(err: unknown): void {
  if (err === null || typeof err !== 'object') return;
  if ((err as { statusCode?: unknown }).statusCode !== 403) return;
  throw_missing_permissions('read');
}

export function throw_missing_permissions(context: 'read' | 'write' = 'read'): never {
  const read_perms = 'Files.Read.All, Sites.Read.All';
  const write_perms = 'Files.ReadWrite.All, Sites.Read.All';
  const perms = context === 'write' ? write_perms : read_perms;
  throw new MissingGraphPermissionsError(
    `Missing Microsoft Graph application permissions for OneDrive: ${perms}.`,
  );
}
