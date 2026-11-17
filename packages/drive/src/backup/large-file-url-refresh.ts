import { logger } from '@wisecom/atlas-core/utils/logger';
import { classify_download_failure } from '@wisecom/atlas-m365-graph';
import type { DriveDeltaItem } from '@/drive-ports';
import type { DriveDownloadUrlResolver, DriveLargeFileDeps } from '@/backup/large-file-pipeline';

/**
 * How many URL refreshes a file may make in a row without a chunk landing in between. A transfer
 * can outlive many URLs, so the budget resets on progress; it only stops a URL that is refused
 * again and again at the same offset.
 */
export const MAX_URL_REFRESHES_WITHOUT_PROGRESS = 3;

/**
 * A large file whose download URL kept expiring with no chunk landing in between.
 *
 * The file is not at fault and the URL is not a reason to skip it for good, so the caller records it
 * without spending one of the item's ledger attempts (issue #718).
 */
export class DownloadUrlExpiredError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'DownloadUrlExpiredError';
  }
}

/** True for the error that means a file was skipped because its download URL expired. */
export function is_download_url_expired(err: unknown): err is DownloadUrlExpiredError {
  return err instanceof DownloadUrlExpiredError;
}

/**
 * Yields a large file's chunks in order from one download URL, re-resolving the URL when it expires
 * and resuming at the chunk that failed rather than at byte zero.
 *
 * A 401 or 403 from the CDN is the only failure that refreshes. A Graph refusal from the re-resolve
 * is rethrown unchanged, so it is classified and recorded as a refusal rather than retried here.
 */
export async function* stream_chunks_with_url_refresh(
  fetch_chunks: DriveLargeFileDeps['fetch_chunks'],
  connector: DriveDownloadUrlResolver,
  item: DriveDeltaItem,
  initial_url: string,
  abort_signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  let download_url = initial_url;
  let offset = 0;
  let refreshes_without_progress = 0;

  for (;;) {
    try {
      for await (const chunk of fetch_chunks(
        download_url,
        item.size_bytes,
        item.item_id,
        abort_signal,
        offset,
      )) {
        offset += chunk.length;
        refreshes_without_progress = 0;
        yield chunk;
      }
      return;
    } catch (err) {
      // A cancelled run stops here and never spends a refresh on a URL it will not use.
      abort_signal?.throwIfAborted();
      if (classify_download_failure(err) !== 'expired_url') throw err;
      if (refreshes_without_progress >= MAX_URL_REFRESHES_WITHOUT_PROGRESS) {
        throw new DownloadUrlExpiredError(
          `Download URL for ${item.item_id} expired ${refreshes_without_progress} times at byte ` +
            `${offset} of ${item.size_bytes} without progress`,
          err,
        );
      }
      refreshes_without_progress++;
      logger.info(
        `Download URL expired for ${item.item_id} at byte ${offset}, re-resolving ` +
          `(refresh ${refreshes_without_progress}/${MAX_URL_REFRESHES_WITHOUT_PROGRESS})`,
      );
      const refreshed_url = await connector.resolve_download_url(item);
      if (!refreshed_url) throw err;
      download_url = refreshed_url;
    }
  }
}
