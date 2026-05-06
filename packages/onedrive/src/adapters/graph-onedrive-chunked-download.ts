import { logger } from '@atlas/core/utils/logger';
import { is_retryable_error } from '@atlas/m365-graph';

/** Maximum bytes per HTTP Range chunk (4 MiB). */
export const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

/** File sizes at or above this use Range-based chunked download. */
export const CHUNK_DOWNLOAD_THRESHOLD = 4 * 1024 * 1024;

const MAX_CHUNK_RETRIES = 5;
const CHUNK_BASE_DELAY_MS = 1_000;
const CHUNK_MAX_DELAY_MS = 30_000;
const MIN_THROUGHPUT_BYTES_PER_MS = 256;

/** Calculates a dynamic timeout scaled to the expected transfer size. */
export function compute_chunk_timeout_ms(chunk_bytes: number): number {
  return Math.max(30_000, Math.ceil(chunk_bytes / MIN_THROUGHPUT_BYTES_PER_MS));
}

/**
 * Downloads a file in Range-based chunks with per-chunk retry.
 * Each chunk is independently retried up to MAX_CHUNK_RETRIES times on
 * transient/network errors, so a mid-transfer failure only replays the
 * affected chunk rather than restarting the entire file.
 */
export async function download_file_chunked(
  download_url: string,
  total_bytes: number,
  item_id: string,
): Promise<Buffer> {
  const chunk_count = Math.ceil(total_bytes / CHUNK_SIZE_BYTES);
  const chunks: Buffer[] = new Array(chunk_count);

  for (let i = 0; i < chunk_count; i++) {
    const range_start = i * CHUNK_SIZE_BYTES;
    const range_end = Math.min(range_start + CHUNK_SIZE_BYTES - 1, total_bytes - 1);
    const expected_length = range_end - range_start + 1;

    chunks[i] = await download_chunk_with_retry(
      download_url,
      range_start,
      range_end,
      expected_length,
      item_id,
      i + 1,
      chunk_count,
    );
  }

  return Buffer.concat(chunks);
}

async function download_chunk_with_retry(
  url: string,
  range_start: number,
  range_end: number,
  expected_length: number,
  item_id: string,
  chunk_index: number,
  total_chunks: number,
): Promise<Buffer> {
  for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
    try {
      return await download_single_chunk(url, range_start, range_end, expected_length, item_id);
    } catch (err) {
      if (!is_retryable_error(err) || attempt === MAX_CHUNK_RETRIES) {
        throw new Error(
          `Failed to download chunk ${chunk_index}/${total_chunks} of file ${item_id} ` +
            `after ${attempt + 1} attempts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const delay = compute_retry_delay(attempt);
      logger.debug(
        `Chunk ${chunk_index}/${total_chunks} retry ${attempt + 1}/${MAX_CHUNK_RETRIES} ` +
          `for file ${item_id} in ${(delay / 1000).toFixed(1)}s`,
      );
      await sleep(delay);
    }
  }

  throw new Error('download_chunk_with_retry: unreachable');
}

async function download_single_chunk(
  url: string,
  range_start: number,
  range_end: number,
  expected_length: number,
  item_id: string,
): Promise<Buffer> {
  const timeout_ms = compute_chunk_timeout_ms(expected_length);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);

  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=${range_start}-${range_end}` },
      signal: controller.signal,
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(
        `HTTP ${response.status} downloading chunk bytes=${range_start}-${range_end} of ${item_id}`,
      );
    }

    const bytes = await response.arrayBuffer();
    return Buffer.from(bytes);
  } finally {
    clearTimeout(timer);
  }
}

function compute_retry_delay(attempt: number): number {
  const base = CHUNK_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * CHUNK_BASE_DELAY_MS;
  return Math.min(base + jitter, CHUNK_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
