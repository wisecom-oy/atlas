import { logger } from '@atlas/core/utils/logger';
import { is_retryable_error } from '@atlas/m365-graph';
import type { OneDriveConnector, OneDriveDeltaItem } from '@atlas/types';

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 30_000;

/** Optional tuning for {@link download_with_retry}. */
export interface DownloadRetryOptions {
  readonly max_attempts?: number;
}

/**
 * Wraps a connector download call in a file-level retry loop.
 * Returns undefined when all attempts are exhausted, allowing
 * the caller to skip the file without throwing.
 */
export async function download_with_retry(
  connector: OneDriveConnector,
  item: OneDriveDeltaItem,
  options: DownloadRetryOptions = {},
): Promise<Buffer | undefined> {
  const max_attempts = options.max_attempts ?? DEFAULT_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= max_attempts; attempt++) {
    try {
      return await connector.download_file_content(item);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const is_last = attempt === max_attempts;

      if (is_last || !is_retryable_error(err)) {
        logger.warn(
          `Skipping OneDrive file ${item.item_id} (${item.file_name}) ` +
            `after ${attempt} attempt(s): ${reason}`,
        );
        return undefined;
      }

      const delay = compute_file_retry_delay(attempt);
      logger.info(
        `File download retry ${attempt}/${max_attempts} for ${item.file_name} ` +
          `(${format_bytes(item.size_bytes)}) in ${(delay / 1000).toFixed(1)}s -- ${reason}`,
      );
      await sleep(delay);
    }
  }

  return undefined;
}

function compute_file_retry_delay(attempt: number): number {
  const base = BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.random() * BASE_DELAY_MS;
  return Math.min(base + jitter, MAX_DELAY_MS);
}

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
