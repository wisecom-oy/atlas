import { logger } from '@wisecom/atlas-core/utils/logger';
import { AuthError } from '@wisecom/atlas-types';
import { is_unretryable_download_failure } from '@wisecom/atlas-m365-graph';
import type { DriveDeltaItem } from '@/drive-ports';
import {
  is_download_size_changed,
  type DownloadSizeChangedError,
} from '@/backup/download-integrity';

/**
 * Re-reads one drive item by id, returning its current size and a fresh download URL. Undefined
 * when Graph reports the item gone.
 */
export type DriveItemRefetch = (item: DriveDeltaItem) => Promise<DriveDeltaItem | undefined>;

/**
 * Runs one download attempt and, when the file's size changed under it, retries once against the
 * item's current metadata (issue #759).
 *
 * SharePoint can rewrite a file on its first download, so the bytes served are longer than the
 * listed size. The retry is the only second look at the item: one extra read, and only for a file
 * that mismatched. A file that still disagrees after that read is skipped as before, so a file
 * that keeps changing cannot loop.
 *
 * Only a size change triggers the refresh. Every other failure is rethrown unchanged, and the
 * truncation checks stay as strict as they were.
 */
export async function attempt_with_size_refresh<T>(
  item: DriveDeltaItem,
  refetch: DriveItemRefetch,
  attempt: (current: DriveDeltaItem) => Promise<T | undefined>,
  abort_signal?: AbortSignal,
): Promise<T | undefined> {
  try {
    return await attempt(item);
  } catch (err) {
    abort_signal?.throwIfAborted();
    if (!is_download_size_changed(err)) throw err;
    return await retry_with_current_size(item, refetch, attempt, err, abort_signal);
  }
}

/** Re-reads the item, and retries once only when its listed size has moved since the download. */
async function retry_with_current_size<T>(
  item: DriveDeltaItem,
  refetch: DriveItemRefetch,
  attempt: (current: DriveDeltaItem) => Promise<T | undefined>,
  err: DownloadSizeChangedError,
  abort_signal?: AbortSignal,
): Promise<T | undefined> {
  const current = await refetch_or_undefined(item, refetch, abort_signal);
  if (!current || current.size_bytes === item.size_bytes) {
    return skip_size_changed(item, err);
  }

  logger.info(
    `Size of ${item.item_id} changed from ${item.size_bytes} to ${err.observed_bytes} bytes during ` +
      `download; item now lists ${current.size_bytes} bytes, retrying once`,
  );
  try {
    return await attempt(current);
  } catch (retry_err) {
    abort_signal?.throwIfAborted();
    if (!is_download_size_changed(retry_err)) throw retry_err;
    return skip_size_changed(item, retry_err);
  }
}

/**
 * Reads the item again. A failed read is not a reason to fail the file on its own, but a cancelled
 * run, a missing grant, a refusal or an expired session still stops the run as it does elsewhere.
 */
async function refetch_or_undefined(
  item: DriveDeltaItem,
  refetch: DriveItemRefetch,
  abort_signal?: AbortSignal,
): Promise<DriveDeltaItem | undefined> {
  try {
    return await refetch(item);
  } catch (err) {
    abort_signal?.throwIfAborted();
    if (err instanceof AuthError || is_unretryable_download_failure(err)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not re-read ${item.item_id} after a size change: ${reason}`);
    return undefined;
  }
}

/**
 * Skips the file the way a failed download is skipped, so the caller records it against the
 * snapshot unchanged from before the refresh existed.
 */
function skip_size_changed(item: DriveDeltaItem, err: DownloadSizeChangedError): undefined {
  logger.warn(
    `Skipping drive file ${item.item_id} (${item.file_name}) after its size changed during ` +
      `download: ${err.message}`,
  );
  return undefined;
}
