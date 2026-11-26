import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  classify_download_failure,
  read_graph_error_code,
  DownloadRefusedError,
  type DownloadFailureKind,
} from '@wisecom/atlas-m365-graph';
import { CHUNK_DOWNLOAD_THRESHOLD, type CdnChunkDownloader } from '@/backup/cdn-chunk-download';
import { download_from_url } from '@/backup/cdn-url-download';
import { DRIVE_WORKLOAD_LABEL } from '@/backup/drive-workload-label';
import { as_expired_url_failure } from '@/backup/expired-url-failure';
import {
  missing_permissions_error,
  rethrow_enumeration_denial,
  type DenialBinding,
  type DeniedResource,
} from '@/backup/enumeration-access-denial';
import {
  download_via_graph_content,
  resolve_download_url,
  type DriveDownloadItem,
  type DriveGraphClient,
} from '@/backup/graph-item-content';
import { is_transient_drive_failure } from '@/backup/transient-download-failure';

/** The values one provider supplies to the shared download executor. */
export interface DriveDownloadBinding extends DenialBinding {
  /** The provider's CDN chunk downloader, used above CHUNK_DOWNLOAD_THRESHOLD. */
  readonly chunk_downloader: CdnChunkDownloader;
}

/** File download for one drive workload, with expired-URL refresh and a Graph fallback. */
export interface DriveDownloadExecutor {
  /**
   * Downloads file content from the pre-authenticated URL, refreshing an expired one, and falls
   * back to Graph `/content` unless the download host itself failed. `abort_signal` ends a transfer
   * and any backoff it is in.
   */
  download_with_fallback(
    client: DriveGraphClient,
    item: DriveDownloadItem,
    abort_signal?: AbortSignal,
  ): Promise<Buffer>;
  /**
   * Resolves a fresh pre-authenticated URL. A Graph 403 gets the same classification as a download
   * failure, so a missing grant stops the run, a known permanent refusal is recorded (issue #246),
   * and any other 403 fails the file for this run only (issue #866).
   */
  resolve_download_url(
    client: DriveGraphClient,
    item: DriveDownloadItem,
  ): Promise<string | undefined>;
  /**
   * Rethrows a Graph 403 from an enumeration call (a site lookup, listing drives or libraries,
   * delta) as `MissingGraphPermissionsError` or `GraphAccessRefusedError`, and returns for anything
   * else. A 403 there has two causes Graph does not tell apart by code: a missing grant, and one
   * resource refused on its own, such as a SharePoint Embedded container (issue #772).
   * `resource` names what was addressed.
   */
  rethrow_if_access_denied(
    client: DriveGraphClient,
    err: unknown,
    resource: DeniedResource,
  ): Promise<void>;
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
    rethrow_if_access_denied: (client, err, resource) =>
      rethrow_enumeration_denial(binding, client, err, resource),
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
  if (!download_url) return await download_via_graph_content(client, item, abort_signal);

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
 * stale URL (issue #246): a stale URL is re-resolved once, a Graph 403 or a missing grant stops, a
 * download host that failed is left to the file-level retry, and anything else falls back to
 * `/content`.
 */
async function attempt_download_with_refresh(
  context: DownloadAttemptContext,
  download_url: string,
  download_fn: (url: string) => Promise<Buffer>,
  strategy_label: string,
): Promise<Buffer> {
  try {
    return await download_fn(download_url);
  } catch (err) {
    // A cancelled run neither refreshes the URL nor falls back to /content: it stops (issue #632).
    context.abort_signal?.throwIfAborted();
    const kind = classify_download_failure(err);
    rethrow_if_unrecoverable(context, kind, err);

    if (kind === 'expired_url') {
      return await recover_expired_url(context, download_fn, strategy_label);
    }
    rethrow_if_download_host_failed(err);
    logger.warn(`${strategy_label} failed for ${context.item.item_id}, falling back: ${err}`);
    return await download_via_graph_content(context.client, context.item, context.abort_signal);
  }
}

/**
 * Rethrows a failure of the download host itself: a transient status, throttling, a reset or a
 * timeout. `/content` answers with a redirect to the same host, so falling back sent the file into
 * the same outage under Graph's 12-retry budget, three times over (issue #885). The file-level
 * retry repeats the download instead, and records the file without spending an attempt once its
 * attempts are spent.
 */
function rethrow_if_download_host_failed(err: unknown): void {
  if (is_transient_drive_failure(err)) throw err;
}

/**
 * Re-resolves an expired URL once and retries on it, then falls back to `/content`. A cancellation
 * during the retry or its 429 wait is rethrown, so a cancelled run never starts the `/content`
 * transfer. A fallback that fails too is charged by `as_expired_url_failure`, so a file whose only
 * problem was its link spends no attempt (issue #895).
 */
async function recover_expired_url(
  context: DownloadAttemptContext,
  download_fn: (url: string) => Promise<Buffer>,
  strategy_label: string,
): Promise<Buffer> {
  const { binding, client, item, abort_signal } = context;
  const refreshed_url = await resolve_fresh_url(binding, client, item);
  if (refreshed_url) {
    try {
      return await download_fn(refreshed_url);
    } catch (retry_err) {
      abort_signal?.throwIfAborted();
      logger.warn(`${strategy_label} retry failed for ${item.item_id}: ${retry_err}`);
      rethrow_if_download_host_failed(retry_err);
    }
  }
  // Checked again here: the refresh above can be where the run was cancelled.
  abort_signal?.throwIfAborted();
  try {
    return await download_via_graph_content(client, item, abort_signal);
  } catch (fallback_err) {
    abort_signal?.throwIfAborted();
    throw as_expired_url_failure(item, fallback_err);
  }
}

/**
 * Throws for the 403 causes that neither a URL refresh nor the `/content` fallback can resolve, so
 * the caller stops instead of spending a second retry budget on a refusal (#246). Only a missing
 * grant and a known permanent refusal outlive the run; an unrecognised 403 fails this attempt only.
 */
function rethrow_if_unrecoverable(
  context: DownloadAttemptContext,
  kind: DownloadFailureKind,
  err: unknown,
): void {
  // A missing grant answers 403 on every item, so the run must stop and name it.
  if (kind === 'missing_permission') {
    const { item } = context;
    throw missing_permissions_error(
      context.binding,
      err,
      `downloading ${item.file_name} (${item.item_id})`,
    );
  }

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

  // Nothing says this refusal will last, so the file fails for this run and the failed-item
  // ledger retries it next run, within its attempt budget (issue #866).
  if (kind === 'unrecognised_refusal') {
    const { item } = context;
    throw new Error(
      `Microsoft 365 refused ${item.file_name} (${item.item_id}): Graph returned 403 ` +
        `${read_graph_error_code(err)}, which Atlas does not recognise as permanent. ` +
        `The file is retried by the next run.`,
      { cause: err },
    );
  }
}
