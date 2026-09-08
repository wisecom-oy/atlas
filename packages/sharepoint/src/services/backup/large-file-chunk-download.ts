import { logger } from '@wisecom/atlas-core/utils/logger';
import { stream_whole_file_in_chunks } from '@wisecom/atlas-drive/backup/whole-file-stream';
import { assert_range_chunk } from '@wisecom/atlas-drive/backup/download-integrity';

const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 5;
const CHUNK_BASE_DELAY_MS = 1_000;
const CHUNK_MAX_DELAY_MS = 30_000;
const MIN_THROUGHPUT_BYTES_PER_MS = 256;

/** Milliseconds a single 4 MiB read may stall before the transfer is abandoned. */
function chunk_stall_timeout_ms(): number {
  return Math.max(30_000, Math.ceil(CHUNK_SIZE_BYTES / MIN_THROUGHPUT_BYTES_PER_MS));
}

/**
 * Raised when the server answers a Range request with the whole file.
 *
 * It is a property of the server, not of the chunk, so the caller stops asking for ranges
 * entirely rather than re-discovering it 255 more times (issue #301).
 */
class RangeIgnoredError extends Error {
  constructor() {
    super('Range header ignored');
    this.name = 'RangeIgnoredError';
  }
}

/** Async generator that yields 4 MiB buffers fetched via HTTP Range requests. */
export async function* fetch_file_chunks(
  download_url: string,
  total_bytes: number,
  item_id: string,
): AsyncGenerator<Buffer> {
  const chunk_count = Math.ceil(total_bytes / CHUNK_SIZE_BYTES);
  let yielded_chunks = 0;

  for (let i = 0; i < chunk_count; i++) {
    const range_start = i * CHUNK_SIZE_BYTES;
    const range_end = Math.min(range_start + CHUNK_SIZE_BYTES - 1, total_bytes - 1);
    const expected_length = range_end - range_start + 1;

    let chunk: Buffer;
    try {
      chunk = await download_chunk_with_retry(
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
      // The streamed pass restarts at byte zero, so it can only replace the chunks already handed
      // to the consumer, never continue them. Once one has been yielded the consumer has fed it
      // into a cipher and appending a second copy of the file would produce a validly encrypted
      // object holding a prefix plus the whole file (issue #338). Fail the item instead; the next
      // run retries it and takes the streamed path from the first chunk.
      if (yielded_chunks > 0) {
        throw new Error(
          `Range requests stopped being honoured for ${item_id} after ${yielded_chunks} chunk(s); ` +
            `the partial transfer cannot be continued by a whole-file download`,
        );
      }
      // Every remaining chunk would fetch and discard the same whole file: a 1 GiB item costs
      // 256 GiB transferred to produce 1 GiB. One streamed pass delivers the whole file instead.
      logger.warn(
        `Range requests are ignored for ${item_id} (HTTP 200 with the full body); ` +
          `falling back to one streamed download`,
      );
      yield* stream_whole_file_in_chunks(download_url, item_id, {
        chunk_size_bytes: CHUNK_SIZE_BYTES,
        // Same per-chunk budget the Range path uses, applied between reads rather than to the
        // whole transfer, so a stalled body is cut off but a slow one is not.
        stall_timeout_ms: chunk_stall_timeout_ms(),
      });
      return;
    }
    yielded_chunks++;
    yield chunk;
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
  total_bytes: number,
  report_ignored_range: boolean,
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

    if (response.status === 200 && report_ignored_range) {
      // Drop the body unread: buffering a whole file per chunk is the cost this avoids.
      await response.body?.cancel();
      throw new RangeIgnoredError();
    }

    const buf = Buffer.from(await response.arrayBuffer());

    if (response.status === 200) {
      // A single-chunk item legitimately comes back whole, so the slice is a no-op there. Anything
      // other than the whole file means the body is not what the slice offsets assume (issue #338).
      if (buf.length !== total_bytes) {
        throw new Error(
          `CDN returned 200 with ${buf.length} bytes for ${item_id}, expected ${total_bytes}`,
        );
      }
      return buf.subarray(range_start, range_end + 1);
    }

    assert_range_chunk(
      item_id,
      range_start,
      range_end,
      response.headers.get('Content-Range'),
      buf.length,
    );
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
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
