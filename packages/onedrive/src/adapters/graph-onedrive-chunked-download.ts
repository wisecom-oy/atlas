import { logger } from '@wisecom/atlas-core/utils/logger';
import { stream_whole_file_in_chunks } from '@wisecom/atlas-drive/backup/whole-file-stream';
import {
  is_retryable_error,
  is_transient_error,
  parse_retry_after_ms,
} from '@wisecom/atlas-m365-graph';

/**
 * Raised when the server answers a Range request with the whole file.
 *
 * It is a property of the server, not of the chunk, so the caller stops asking for ranges
 * entirely rather than re-discovering it once per chunk (issue #301).
 */
class RangeIgnoredError extends Error {
  constructor() {
    super('Range header ignored');
    this.name = 'RangeIgnoredError';
  }
}

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

    try {
      yield await download_chunk_with_retry(
        download_url,
        range_start,
        range_end,
        expected_length,
        item_id,
        i + 1,
        chunk_count,
        total_bytes,
        chunk_count > 1,
      );
    } catch (err) {
      if (!(err instanceof RangeIgnoredError)) throw err;
      // Every remaining chunk would fetch and discard the same whole file: a 1 GiB item costs
      // 256 GiB transferred to produce 1 GiB. One streamed pass delivers the rest, and the
      // chunks already yielded are re-read from the start, which is the price of finding out.
      logger.warn(
        `Range requests are ignored for ${item_id} (HTTP 200 with the full body); ` +
          `falling back to one streamed download`,
      );
      yield* stream_whole_file_in_chunks(download_url, item_id, {
        chunk_size_bytes: CHUNK_SIZE_BYTES,
        // Same per-chunk budget the Range path uses, applied between reads rather than to the
        // whole transfer, so a stalled body is cut off but a slow one is not (issue #198).
        stall_timeout_ms: compute_chunk_timeout_ms(CHUNK_SIZE_BYTES),
      });
      return;
    }
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
  report_ignored_range: boolean,
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
        report_ignored_range,
      );
    } catch (err) {
      // Not retryable and not a failure: the caller switches strategy on it.
      if (err instanceof RangeIgnoredError) throw err;
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
  report_ignored_range: boolean,
): Promise<Buffer> {
  // Scaled to this chunk, not to the file. Passing total_bytes here gave every
  // non-final chunk a ceil(total_bytes / 256) ms budget, so one stalled CDN
  // connection held a 1 GB backup for ~68 minutes before aborting (issue #198).
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), compute_chunk_timeout_ms(expected_length));

  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=${range_start}-${range_end}` },
      signal: controller.signal,
    });

    if (response.status === 429) {
      const retry_after_ms = parse_retry_after_ms(response.headers.get('Retry-After'));
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

    // A CDN that ignored the Range header answers 200 with the entire file, so
    // the body about to be drained is total_bytes rather than one chunk. Only
    // that case needs the whole-file budget, and by now it is known rather than
    // assumed, so re-arm before reading instead of pre-paying on every chunk.
    if (response.status === 200 && report_ignored_range) {
      // Drop the body unread: buffering a whole file per chunk is the cost this avoids.
      await response.body?.cancel();
      throw new RangeIgnoredError();
    }

    if (response.status === 200) {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), compute_chunk_timeout_ms(total_bytes));
    }

    const buf = Buffer.from(await response.arrayBuffer());

    if (response.status === 200) {
      // A single-chunk item legitimately comes back whole, so the slice is a no-op there.
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
  // One classifier for Graph and the CDN in front of it: a 500 or 502 on a
  // chunk is as transient here as on any other Graph call (issue #36).
  if (err instanceof CdnHttpError) return is_transient_error({ statusCode: err.status_code });
  return is_retryable_error(err);
}

function extract_cdn_retry_after_from_error(err: unknown): number | undefined {
  if (err instanceof CdnHttpError) return err.retry_after_ms;
  return undefined;
}

function compute_retry_delay(attempt: number): number {
  const base = CHUNK_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * CHUNK_BASE_DELAY_MS;
  return Math.min(base + jitter, CHUNK_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
