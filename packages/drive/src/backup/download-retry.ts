import { logger } from '@wisecom/atlas-core/utils/logger';
import { is_graph_outage } from '@wisecom/atlas-core/services/shared/graph-outage-latch';
import { cancellable_sleep, is_unretryable_download_failure } from '@wisecom/atlas-m365-graph';
import type { DriveContentConnector, DriveDeltaItem } from '@/drive-ports';
import { is_download_size_changed } from '@/backup/download-integrity';
import { is_download_url_expired } from '@/backup/large-file-url-refresh';
import {
  is_transient_drive_failure,
  transient_download_error_for,
} from '@/backup/transient-download-failure';
import { format_bytes } from '@/shared/format-bytes';

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 30_000;

/** Optional tuning for {@link download_with_retry}. */
export interface DownloadRetryOptions {
  readonly max_attempts?: number;
  /**
   * Cancellation for the run.
   *
   * It is handed to the connector, which aborts a transfer from a pre-authenticated URL, its chunk
   * backoff, and a Graph `/content` request that has not answered yet. This loop also stops
   * starting another attempt or sitting out a backoff of up to 30 seconds after the run was
   * cancelled (issues #344, #632).
   */
  readonly abort_signal?: AbortSignal | undefined;
}

/**
 * Wraps a connector download call in a file-level retry loop.
 * Returns undefined when the file's own fault ends the attempts, allowing
 * the caller to skip the file and spend one of its ledger attempts.
 *
 * A missing grant and a service refusal are the exceptions: both are rethrown so
 * the caller can name the cause. Swallowing them here is what turned one missing
 * permission into a per-file retry storm reported as a skipped file (issue #246).
 * A size change is the third exception, so the caller can re-read the item (issue #759), and an
 * expired URL whose refresh and `/content` fallback failed is the fourth, so the caller records it
 * without spending an attempt (issue #895).
 * A failure outside the file (throttling, an outage, a reset or timeout) is repeated up to
 * `max_attempts` times and then ends as a `TransientDownloadError`, so the caller records it
 * without spending an attempt (issues #857, #890).
 */
export async function download_with_retry(
  connector: DriveContentConnector,
  item: DriveDeltaItem,
  options: DownloadRetryOptions = {},
): Promise<Buffer | undefined> {
  const max_attempts = options.max_attempts ?? DEFAULT_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= max_attempts; attempt++) {
    options.abort_signal?.throwIfAborted();
    try {
      return await connector.download_file_content(item, options.abort_signal);
    } catch (err) {
      // A cancelled run is not a failed file. Returning undefined here had the caller record the
      // item in the failed-item ledger, so each cancel during a transfer spent one of its attempts
      // (issue #632).
      options.abort_signal?.throwIfAborted();
      const reason = err instanceof Error ? err.message : String(err);
      const is_last = attempt === max_attempts;

      rethrow_if_caller_decides(err);
      if (is_last || !is_worth_another_attempt(err)) return give_up_on_file(err, item, attempt);

      const delay = compute_file_retry_delay(attempt);
      logger.info(
        `File download retry ${attempt}/${max_attempts} for ${item.file_name} ` +
          `(${format_bytes(item.size_bytes)}) in ${(delay / 1000).toFixed(1)}s -- ${reason}`,
      );
      await cancellable_sleep(delay, options.abort_signal);
    }
  }

  return undefined;
}

/**
 * Ends the download once its attempts are spent or the failure is not worth repeating. Throws
 * `TransientDownloadError` for a failure outside the file, and returns undefined for the file's own
 * so the caller spends one of its ledger attempts (issue #857).
 */
function give_up_on_file(err: unknown, item: DriveDeltaItem, attempts_made: number): undefined {
  const reason = err instanceof Error ? err.message : String(err);
  logger.warn(
    `Skipping drive file ${item.item_id} (${item.file_name}) ` +
      `after ${attempts_made} attempt(s): ${reason}`,
  );
  const transient = transient_download_error_for(err, `${item.file_name} (${item.item_id})`);
  if (transient) throw transient;
  return undefined;
}

/**
 * Rethrows a failure the caller acts on itself instead of this loop retrying it: a refusal or a
 * missing grant (issue #246), a size change the caller re-reads the item for once (issue #759), and
 * an expired URL whose refresh and `/content` fallback were this file's retry already, which the
 * caller records without spending an attempt (issue #895).
 */
function rethrow_if_caller_decides(err: unknown): void {
  if (is_unretryable_download_failure(err)) throw err;
  if (is_download_size_changed(err)) throw err;
  if (is_download_url_expired(err)) throw err;
}

/**
 * True for a failure outside the file that another attempt may get past: a transient status, a
 * reset, or a timed-out request or body (issue #890). A failure that already spent Microsoft
 * Graph's whole retry budget is not, because repeating it would wait out that budget again for the
 * same file, and in a backup run the outage latch ends every later Graph call anyway (issue #885).
 */
function is_worth_another_attempt(err: unknown): boolean {
  return is_transient_drive_failure(err) && !is_graph_outage(err);
}

function compute_file_retry_delay(attempt: number): number {
  const base = BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.random() * BASE_DELAY_MS;
  return Math.min(base + jitter, MAX_DELAY_MS);
}
