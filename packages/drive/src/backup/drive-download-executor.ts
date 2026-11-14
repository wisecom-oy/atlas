import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  classify_download_failure,
  read_graph_error_code,
  DownloadRefusedError,
  MissingGraphPermissionsError,
  type DownloadFailureKind,
} from '@wisecom/atlas-m365-graph';
import type { DriveWorkload } from '@/drive-ports';
import { CHUNK_DOWNLOAD_THRESHOLD, type CdnChunkDownloader } from '@/backup/cdn-chunk-download';
import { download_from_url } from '@/backup/cdn-url-download';
import { DRIVE_WORKLOAD_LABEL } from '@/backup/drive-workload-label';
import {
  download_via_graph_content,
  resolve_download_url,
  type DriveDownloadItem,
  type DriveGraphClient,
} from '@/backup/graph-item-content';

/** The values one provider supplies to the shared download executor. */
export interface DriveDownloadBinding {
  readonly workload: DriveWorkload;
  /** The application permissions a missing-grant error names, e.g. `Sites.Read.All`. */
  readonly read_permissions: string;
  /** The provider's CDN chunk downloader, used above CHUNK_DOWNLOAD_THRESHOLD. */
  readonly chunk_downloader: CdnChunkDownloader;
}

/** File download for one drive workload, with expired-URL refresh and a Graph fallback. */
export interface DriveDownloadExecutor {
  /**
   * Downloads file content from the pre-authenticated URL, refreshing an expired one, and falls
   * back to Graph `/content`. `abort_signal` ends a transfer from the URL and any backoff it is in.
   */
  download_with_fallback(
    client: DriveGraphClient,
    item: DriveDownloadItem,
    abort_signal?: AbortSignal,
  ): Promise<Buffer>;
  /**
   * Resolves a fresh pre-authenticated URL. A Graph 403 gets the same classification as a download
   * failure, so a missing grant stops the run and a service refusal is recorded (issue #246).
   */
  resolve_download_url(
    client: DriveGraphClient,
    item: DriveDownloadItem,
  ): Promise<string | undefined>;
  /**
   * Rethrows any Graph 403 as a missing grant.
   *
   * Deliberately broader than the download-path classification. Its callers are the enumeration
   * paths (listing drives or libraries, delta), where a 403 has one plausible cause: there is no
   * per-item protection state when listing. The split between a missing grant and a service
   * refusal belongs to the download path, where both are reachable for the same item (issue #246).
   */
  rethrow_if_access_denied(err: unknown): void;
}

/** Everything the attempt needs that is not the attempt itself. */
interface DownloadAttemptContext {
  readonly binding: DriveDownloadBinding;
  readonly client: DriveGraphClient;
  readonly item: DriveDownloadItem;
  readonly abort_signal: AbortSignal | undefined;
}

/**
 * Builds the download executor for one drive workload.
 *
 * OneDrive and SharePoint download the same way and differ only in the label and the permission
 * names, so there is one implementation. The two copies it replaced had drifted: OneDrive's URL
 * download never typed its failure or retried a 429 (issue #675), and SharePoint's stream drain
 * leaked its timer when the stream errored (issue #676).
 */
export function create_drive_download_executor(
  binding: DriveDownloadBinding,
): DriveDownloadExecutor {
  return {
    download_with_fallback: (client, item, abort_signal) =>
      download_with_fallback({ binding, client, item, abort_signal }),
    resolve_download_url: (client, item) => resolve_fresh_url(binding, client, item),
    rethrow_if_access_denied: (err) => rethrow_if_access_denied(binding, err),
  };
}

/** Resolves a fresh URL, rethrowing a Graph 403 as the missing grant or refusal it means. */
async function resolve_fresh_url(
  binding: DriveDownloadBinding,
  client: DriveGraphClient,
  item: DriveDownloadItem,
): Promise<string | undefined> {
  try {
    return await resolve_download_url(client, item);
  } catch (err) {
    rethrow_if_unrecoverable(
      { binding, client, item, abort_signal: undefined },
      classify_download_failure(err),
      err,
    );
    throw err;
  }
}

/** True only for a stale pre-authenticated URL, which is the one 403 worth retrying. */
export function is_expired_url_error(err: unknown): boolean {
  return classify_download_failure(err) === 'expired_url';
}

/** Picks the chunked or single-request URL download by size, or `/content` when no URL resolves. */
async function download_with_fallback(context: DownloadAttemptContext): Promise<Buffer> {
  const { binding, client, item, abort_signal } = context;
  const download_url = item.download_url ?? (await resolve_fresh_url(binding, client, item));
  if (!download_url) return await download_via_graph_content(client, item);

  const label = DRIVE_WORKLOAD_LABEL[binding.workload];
  if (item.size_bytes > CHUNK_DOWNLOAD_THRESHOLD) {
    const download_chunked = (url: string): Promise<Buffer> =>
      binding.chunk_downloader.download_file_chunked(
        url,
        item.size_bytes,
        item.item_id,
        abort_signal,
      );
    return await attempt_download_with_refresh(
      context,
      download_url,
      download_chunked,
      'Chunked download',
    );
  }
  const download_whole = (url: string): Promise<Buffer> =>
    download_from_url(label, url, item.size_bytes, item.item_id, abort_signal);
  return await attempt_download_with_refresh(context, download_url, download_whole, 'URL download');
}

/**
 * Runs a download attempt, acting on the cause of a failure rather than assuming every 403 is a
 * stale URL (issue #246): a stale URL is re-resolved once, a refusal or a missing grant stops, and
 * anything else falls back to `/content`.
 */
async function attempt_download_with_refresh(
  context: DownloadAttemptContext,
  download_url: string,
  download_fn: (url: string) => Promise<Buffer>,
  strategy_label: string,
): Promise<Buffer> {
  const { client, item, abort_signal } = context;
  try {
    return await download_fn(download_url);
  } catch (err) {
    // A cancelled run neither refreshes the URL nor falls back to /content: it stops (issue #632).
    abort_signal?.throwIfAborted();
    const kind = classify_download_failure(err);
    rethrow_if_unrecoverable(context, kind, err);

    if (kind === 'expired_url') {
      const body = await retry_with_refreshed_url(context, download_fn, strategy_label);
      if (body !== undefined) return body;
    } else {
      logger.warn(`${strategy_label} failed for ${item.item_id}, falling back: ${err}`);
    }
    // Checked again here: the refresh above can be where the run was cancelled.
    abort_signal?.throwIfAborted();
    return await download_via_graph_content(client, item);
  }
}

/**
 * Re-resolves the download URL once and retries on it. Undefined when no fresh URL resolves or
 * the retry fails, so the caller falls back; a cancellation during the retry or its 429 wait is
 * rethrown, so a cancelled run never starts the `/content` transfer.
 */
async function retry_with_refreshed_url(
  context: DownloadAttemptContext,
  download_fn: (url: string) => Promise<Buffer>,
  strategy_label: string,
): Promise<Buffer | undefined> {
  const { binding, client, item, abort_signal } = context;
  const refreshed_url = await resolve_fresh_url(binding, client, item);
  if (!refreshed_url) return undefined;
  try {
    return await download_fn(refreshed_url);
  } catch (retry_err) {
    abort_signal?.throwIfAborted();
    logger.warn(`${strategy_label} retry failed for ${item.item_id}: ${retry_err}`);
    return undefined;
  }
}

/**
 * Throws for the two 403 causes that neither a URL refresh nor the `/content` fallback can
 * resolve, so the caller stops instead of spending a second retry budget on a refusal (#246).
 */
function rethrow_if_unrecoverable(
  context: DownloadAttemptContext,
  kind: DownloadFailureKind,
  err: unknown,
): void {
  // A missing grant answers 403 on every item, so the run must stop and name it.
  if (kind === 'missing_permission') throw missing_permissions_error(context.binding);

  // The service will keep refusing this item, so it is recorded against the snapshot with the
  // code that explains it, rather than retried.
  if (kind === 'service_refused') {
    const { item } = context;
    const code = read_graph_error_code(err);
    throw new DownloadRefusedError(
      `Microsoft 365 refused to release ${item.file_name} (${item.item_id}): ` +
        `Graph returned 403 ${code}. This is a protection or policy state on the ` +
        `item, not a transient failure.`,
      code,
    );
  }
}

/** Rethrows a Graph 403 from an enumeration call as the binding's missing-grant error. */
function rethrow_if_access_denied(binding: DriveDownloadBinding, err: unknown): void {
  if (err === null || typeof err !== 'object') return;
  if ((err as { statusCode?: unknown }).statusCode !== 403) return;
  throw missing_permissions_error(binding);
}

/** The missing-grant error naming the workload and the permissions to grant. */
function missing_permissions_error(binding: DriveDownloadBinding): MissingGraphPermissionsError {
  const label = DRIVE_WORKLOAD_LABEL[binding.workload];
  return new MissingGraphPermissionsError(
    `Missing Microsoft Graph application permissions for ${label}: ${binding.read_permissions}.`,
  );
}
