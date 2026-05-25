import { logger } from '@atlas/core/utils/logger';

const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 5;
const CHUNK_BASE_DELAY_MS = 1_000;
const CHUNK_MAX_DELAY_MS = 30_000;
const MIN_THROUGHPUT_BYTES_PER_MS = 256;

/** Async generator that yields 4 MiB buffers fetched via HTTP Range requests. */
export async function* fetch_file_chunks(
  download_url: string,
  total_bytes: number,
  item_id: string,
): AsyncGenerator<Buffer> {
  const chunk_count = Math.ceil(total_bytes / CHUNK_SIZE_BYTES);

  for (let i = 0; i < chunk_count; i++) {
    const range_start = i * CHUNK_SIZE_BYTES;
    const range_end = Math.min(range_start + CHUNK_SIZE_BYTES - 1, total_bytes - 1);
    const expected_length = range_end - range_start + 1;

    yield await download_chunk_with_retry(
      download_url,
      range_start,
      range_end,
      expected_length,
      item_id,
      i + 1,
      chunk_count,
    );
  }
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
      if (!is_cdn_retryable(err) || attempt === MAX_CHUNK_RETRIES) {
        throw new Error(
          `Failed chunk ${chunk_index}/${total_chunks} of ${item_id} ` +
            `after ${attempt + 1} attempts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const delay = compute_retry_delay(attempt);
      logger.debug(
        `Chunk ${chunk_index}/${total_chunks} retry ${attempt + 1}/${MAX_CHUNK_RETRIES} ` +
          `for ${item_id} in ${(delay / 1000).toFixed(1)}s`,
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
  const timeout_ms = Math.max(30_000, Math.ceil(expected_length / MIN_THROUGHPUT_BYTES_PER_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);

  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=${range_start}-${range_end}` },
      signal: controller.signal,
    });

    if (response.status === 429 || response.status === 503 || response.status === 504) {
      throw new Error(
        `HTTP ${response.status} for chunk bytes=${range_start}-${range_end} of ${item_id}`,
      );
    }

    if (response.status !== 206 && response.status !== 200) {
      throw new Error(
        `HTTP ${response.status} for chunk bytes=${range_start}-${range_end} of ${item_id}`,
      );
    }

    const buf = Buffer.from(await response.arrayBuffer());

    if (response.status === 200) {
      logger.warn(
        `CDN returned HTTP 200 instead of 206 for Range request on ${item_id} — ` +
          `server ignored Range header, slicing ${buf.length} bytes to expected range`,
      );
      if (buf.length < range_end + 1) {
        throw new Error(
          `CDN returned 200 with ${buf.length} bytes but range_end is ${range_end} for ${item_id}`,
        );
      }
      return buf.subarray(range_start, range_end + 1);
    }

    return buf;
  } finally {
    clearTimeout(timer);
  }
}

function is_cdn_retryable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('429') || message.includes('503') || message.includes('504');
}

function compute_retry_delay(attempt: number): number {
  const base = CHUNK_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * CHUNK_BASE_DELAY_MS;
  return Math.min(base + jitter, CHUNK_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
