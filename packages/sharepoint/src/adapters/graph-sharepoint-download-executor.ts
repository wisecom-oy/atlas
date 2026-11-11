import { logger } from '@wisecom/atlas-core/utils/logger';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';
import type { Client } from '@microsoft/microsoft-graph-client';
import {
  with_graph_retry,
  classify_download_failure,
  read_graph_error_code,
  DownloadRefusedError,
  MissingGraphPermissionsError,
  cancellable_sleep,
  parse_retry_after_ms,
  report_transfer_throttle,
  wait_for_transfer_slot,
} from '@wisecom/atlas-m365-graph';
import { CdnHttpError } from '@wisecom/atlas-drive/backup/cdn-chunk-errors';
import { CHUNK_DOWNLOAD_THRESHOLD } from '@wisecom/atlas-drive/backup/cdn-chunk-download';
import { compute_chunk_timeout_ms } from '@wisecom/atlas-drive/backup/cdn-chunk-request';
import { assert_transferred_size } from '@wisecom/atlas-drive/backup/download-integrity';
import { SHAREPOINT_CHUNK_DOWNLOADER } from '@/adapters/graph-sharepoint-chunk-downloader';

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

/**
 * Downloads file content with chunked download, expired-URL refresh, and Graph fallback.
 * `abort_signal` ends a transfer from the pre-authenticated URL and any backoff it is in.
 */
export async function download_with_fallback(
  client: Client,
  item: SharePointDeltaItem,
  abort_signal?: AbortSignal,
): Promise<Buffer> {
  const download_url = item.download_url ?? (await resolve_download_url(client, item));

  if (download_url && item.size_bytes > CHUNK_DOWNLOAD_THRESHOLD) {
    return await attempt_download_with_refresh(
      client,
      item,
      download_url,
      (url) =>
        SHAREPOINT_CHUNK_DOWNLOADER.download_file_chunked(
          url,
          item.size_bytes,
          item.item_id,
          abort_signal,
        ),
      'Chunked download',
      abort_signal,
    );
  }

  if (download_url) {
    return await attempt_download_with_refresh(
      client,
      item,
      download_url,
      (url) => download_from_url(url, item.size_bytes, item.item_id, abort_signal),
      'URL download',
      abort_signal,
    );
  }

  return await download_via_graph_content(client, item);
}

/**
 * Attempts a CDN download, acting on the cause of a failure rather than assuming
 * every 403 is a stale URL (issue #246). Kept identical to the OneDrive twin.
 */
async function attempt_download_with_refresh(
  client: Client,
  item: SharePointDeltaItem,
  download_url: string,
  download_fn: (url: string) => Promise<Buffer>,
  failure_label: string,
  abort_signal: AbortSignal | undefined,
): Promise<Buffer> {
  try {
    return await download_fn(download_url);
  } catch (err) {
    // A cancelled run neither refreshes the URL nor falls back to /content: it stops (issue #632).
    abort_signal?.throwIfAborted();
    const kind = classify_download_failure(err);

    // A missing grant answers 403 on every item, so re-resolving and then spending a
    // second /content retry budget per file only delays naming the real cause.
    if (kind === 'missing_permission') {
      throw new MissingGraphPermissionsError(
        'Missing Microsoft Graph application permissions for SharePoint: Sites.Read.All.',
      );
    }

    // The service will keep refusing this item, so it is recorded against the
    // snapshot with the code that explains it, rather than retried.
    if (kind === 'service_refused') {
      throw new DownloadRefusedError(
        `Microsoft 365 refused to release ${item.file_name} (${item.item_id}): ` +
          `Graph returned 403 ${read_graph_error_code(err)}. This is a protection or ` +
          `policy state on the item, not a transient failure.`,
        read_graph_error_code(err),
      );
    }

    if (kind === 'expired_url') {
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

/**
 * Downloads via the Graph /content endpoint with stream drain.
 *
 * The drained byte count is checked against the recorded size for the same reason the chunked
 * path checks it: a complete-looking body of the wrong length would otherwise be stored with a
 * checksum computed over those wrong bytes (issue #368).
 */
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
  const body = await stream_to_buffer(stream, drain_timeout_ms);
  assert_transferred_size(item.item_id, body.length, item.size_bytes);
  return body;
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
 * enumeration paths in the connector, where a 403 has one plausible cause: there is
 * no per-item protection state when listing a library. The finer split between a
 * missing grant and a service refusal belongs to the download path, where both are
 * reachable for the same item (issue #246).
 */
export function rethrow_if_access_denied(err: unknown): void {
  if (err === null || typeof err !== 'object') return;
  if ((err as { statusCode?: unknown }).statusCode !== 403) return;
  throw new MissingGraphPermissionsError(
    'Missing Microsoft Graph application permissions for SharePoint: Sites.Read.All.',
  );
}

/**
 * Downloads a pre-authenticated URL into a buffer, retrying a 429 up to MAX_URL_RETRIES times.
 *
 * The wait honours `Retry-After` through the shared parser, so an HTTP-date is understood and a
 * huge value is clamped to an hour. The private `parseInt` copy it replaces overflowed `setTimeout`
 * on a value above 2^31-1 ms and retried after about 1 ms (issue #628).
 */
async function download_from_url(
  download_url: string,
  size_bytes: number,
  item_id: string,
  abort_signal?: AbortSignal,
): Promise<Buffer> {
  const timeout_ms = compute_chunk_timeout_ms(size_bytes);

  for (let attempt = 0; attempt <= MAX_URL_RETRIES; attempt++) {
    await wait_for_transfer_slot(abort_signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms);
    const cancel_request = (): void => controller.abort(abort_signal?.reason);
    abort_signal?.addEventListener('abort', cancel_request, { once: true });
    try {
      const response = await fetch(download_url, { signal: controller.signal });
      report_transfer_throttle(response);

      if (response.status === 429) {
        const retry_after = parse_retry_after_ms(response.headers.get('Retry-After'));
        if (attempt < MAX_URL_RETRIES) {
          const delay = retry_after ?? 1_000 * 2 ** attempt;
          logger.debug(`HTTP 429 downloading ${item_id}, retry in ${delay}ms`);
          // Released before the wait, so the abort listener does not outlive this attempt.
          abort_signal?.removeEventListener('abort', cancel_request);
          await cancellable_sleep(delay, abort_signal);
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

      const body = Buffer.from(await response.arrayBuffer());
      // A well-framed 200 carrying the wrong body would otherwise be hashed, encrypted and
      // written with a checksum matching those wrong bytes (issue #368).
      assert_transferred_size(item_id, body.length, size_bytes);
      return body;
    } finally {
      clearTimeout(timer);
      abort_signal?.removeEventListener('abort', cancel_request);
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
  const chunks: Uint8Array[] = [];
  const read_stream = async (): Promise<void> => {
    for await (const chunk of readable as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
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
