import { logger } from '@wisecom/atlas-core/utils/logger';
import { is_retryable_error } from '@wisecom/atlas-m365-graph';

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
 * Async generator that yields 4 MiB buffers fetched via HTTP Range requests.
 * Each chunk is retried independently (5 attempts, exponential backoff).
 */
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
      total_bytes,
    );
  }
}

/**
 * Downloads a file in Range-based chunks with per-chunk retry.
 * Collects chunks via the streaming generator to avoid holding a
 * pre-allocated array and the final concat buffer simultaneously.
 */
export async function download_file_chunked(
  download_url: string,
  total_bytes: number,
  item_id: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of fetch_file_chunks(download_url, total_bytes, item_id)) {
    chunks.push(chunk);
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
  total_bytes: number,
): Promise<Buffer> {
  for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
    try {
      return await download_single_chunk(
        url,
        range_start,
        range_end,
        expected_length,
        item_id,
        total_bytes,
      );
    } catch (err) {
      if (!is_cdn_retryable(err) || attempt === MAX_CHUNK_RETRIES) {
        throw new Error(
          `Failed chunk ${chunk_index}/${total_chunks} of ${item_id} ` +
            `after ${attempt + 1} attempts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const cdn_retry_after = extract_cdn_retry_after_from_error(err);
      const delay = cdn_retry_after ?? compute_retry_delay(attempt);
      logger.debug(
        `Chunk ${chunk_index}/${total_chunks} retry ${attempt + 1}/${MAX_CHUNK_RETRIES} ` +
          `for ${item_id} in ${(delay / 1000).toFixed(1)}s`,
      );
      await sleep(delay);
    }
  }

  throw new Error('download_chunk_with_retry: unreachable');
}

export class CdnHttpError extends Error {
  constructor(
    message: string,
    readonly status_code: number,
    readonly retry_after_ms?: number,
  ) {
    super(message);
    this.name = 'CdnHttpError';
  }
}

async function download_single_chunk(
  url: string,
  range_start: number,
  range_end: number,
  expected_length: number,
  item_id: string,
  total_bytes: number,
): Promise<Buffer> {
  const timeout_ms = compute_chunk_timeout_ms(
    expected_length < total_bytes ? total_bytes : expected_length,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);

  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=${range_start}-${range_end}` },
      signal: controller.signal,
    });

    if (response.status === 429) {
      const retry_after_ms = parse_retry_after_header(response.headers.get('Retry-After'));
      throw new CdnHttpError(
        `HTTP 429 for chunk bytes=${range_start}-${range_end} of ${item_id}`,
        429,
        retry_after_ms,
      );
    }

    if (response.status !== 206 && response.status !== 200) {
      throw new CdnHttpError(
        `HTTP ${response.status} for chunk bytes=${range_start}-${range_end} of ${item_id}`,
        response.status,
      );
    }

    const buf = Buffer.from(await response.arrayBuffer());

    if (response.status === 200) {
      logger.warn(
        `CDN returned HTTP 200 instead of 206 for Range request on ${item_id} — ` +
          `server ignored Range header, slicing ${buf.length} bytes to expected range`,
      );
      if (buf.length < range_end + 1) {
        throw new CdnHttpError(
          `CDN returned 200 with ${buf.length} bytes but range_end is ${range_end} for ${item_id}`,
          200,
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
  if (err instanceof CdnHttpError) {
    return err.status_code === 429 || err.status_code === 503 || err.status_code === 504;
  }
  return is_retryable_error(err);
}

function extract_cdn_retry_after_from_error(err: unknown): number | undefined {
  if (err instanceof CdnHttpError) return err.retry_after_ms;
  return undefined;
}

function parse_retry_after_header(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = parseInt(value, 10);
  return isNaN(seconds) ? undefined : seconds * 1000;
}

function compute_retry_delay(attempt: number): number {
  const base = CHUNK_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * CHUNK_BASE_DELAY_MS;
  return Math.min(base + jitter, CHUNK_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
