import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  cancellable_sleep,
  is_retryable_error,
  is_transient_error,
} from '@wisecom/atlas-m365-graph';
import type { DriveWorkload } from '@/drive-ports';
import { DRIVE_WORKLOAD_LABEL } from '@/backup/drive-workload-label';
import { stream_whole_file_in_chunks } from '@/backup/whole-file-stream';
import { DownloadIntegrityError, size_checked_chunks } from '@/backup/download-integrity';
import { CdnHttpError, ChunkDownloadError, RangeIgnoredError } from '@/backup/cdn-chunk-errors';
import {
  CHUNK_SIZE_BYTES,
  compute_chunk_timeout_ms,
  download_single_chunk,
  type ChunkRequest,
} from '@/backup/cdn-chunk-request';

/** File sizes above this use Range-based chunked download. */
export const CHUNK_DOWNLOAD_THRESHOLD = 4 * 1024 * 1024;

const MAX_CHUNK_RETRIES = 5;
const CHUNK_BASE_DELAY_MS = 1_000;
const CHUNK_MAX_DELAY_MS = 30_000;

/** Range-based download of one file from its pre-authenticated URL, bound to a workload. */
export interface CdnChunkDownloader {
  /**
   * Yields the file in 4 MiB chunks, starting at `start_offset` (a multiple of the chunk size) so a
   * download can resume after a refreshed URL. Each chunk is retried on its own.
   */
  fetch_file_chunks(
    download_url: string,
    total_bytes: number,
    item_id: string,
    abort_signal?: AbortSignal,
    start_offset?: number,
  ): AsyncGenerator<Buffer>;
  /** Downloads the whole file into one buffer through {@link CdnChunkDownloader.fetch_file_chunks}. */
  download_file_chunked(
    download_url: string,
    total_bytes: number,
    item_id: string,
    abort_signal?: AbortSignal,
  ): Promise<Buffer>;
}

/**
 * Builds the chunk downloader for one drive workload.
 *
 * OneDrive and SharePoint fetch from the same CDN with the same rules, so there is one
 * implementation; the workload only names the files in logs and errors. Three copies of it drifted
 * apart before: the SharePoint ones lost cancellation (#344) and the HTTP status a failure carried
 * (issue #632).
 */
export function create_cdn_chunk_downloader(workload: DriveWorkload): CdnChunkDownloader {
  const label = DRIVE_WORKLOAD_LABEL[workload];
  return {
    fetch_file_chunks: (download_url, total_bytes, item_id, abort_signal, start_offset) =>
      fetch_file_chunks(label, download_url, total_bytes, item_id, abort_signal, start_offset),
    download_file_chunked: (download_url, total_bytes, item_id, abort_signal) =>
      collect_chunks(fetch_file_chunks(label, download_url, total_bytes, item_id, abort_signal)),
  };
}

/** Concatenates every chunk, without holding a pre-sized array beside the final buffer. */
async function collect_chunks(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

/**
 * Yields the file chunk by chunk from `start_offset`, switching to one streamed download if the
 * server ignores Range before any chunk has been yielded.
 */
async function* fetch_file_chunks(
  label: string,
  download_url: string,
  total_bytes: number,
  item_id: string,
  abort_signal?: AbortSignal,
  start_offset = 0,
): AsyncGenerator<Buffer> {
  if (start_offset % CHUNK_SIZE_BYTES !== 0) {
    throw new RangeError(`Chunk download of ${item_id} must start on a chunk boundary`);
  }
  const chunk_count = Math.ceil(total_bytes / CHUNK_SIZE_BYTES);
  const first_chunk = start_offset / CHUNK_SIZE_BYTES;
  // Chunks already handed to the consumer count as yielded, so a range ignored on a resumed
  // download fails the item rather than restarting the whole file into the cipher (issue #338).
  let yielded_chunks = first_chunk;

  for (let i = first_chunk; i < chunk_count; i++) {
    // Cheap between chunks, and the signal also reaches the request itself, so a cancelled run
    // neither starts the next chunk nor waits out the one in flight (issue #344).
    abort_signal?.throwIfAborted();
    const range_start = i * CHUNK_SIZE_BYTES;
    const request: ChunkRequest = {
      url: download_url,
      item_id,
      range_start,
      range_end: Math.min(range_start + CHUNK_SIZE_BYTES - 1, total_bytes - 1),
      total_bytes,
      report_ignored_range: chunk_count > 1,
    };

    let chunk: Buffer;
    try {
      chunk = await download_chunk_with_retry(label, request, i + 1, chunk_count, abort_signal);
    } catch (err) {
      if (!(err instanceof RangeIgnoredError)) throw err;
      yield* stream_after_ignored_range(label, request, yielded_chunks, abort_signal);
      return;
    }
    yielded_chunks++;
    yield chunk;
  }
}

/**
 * Replaces the Range requests with one streamed download once the server is known to ignore them.
 *
 * Every remaining chunk would fetch and discard the same whole file: a 1 GiB item costs 256 GiB
 * transferred to produce 1 GiB. The streamed pass restarts at byte zero, though, so it can only
 * replace chunks not yet handed to the consumer. Once one has been yielded it has been fed into a
 * cipher, and appending a second copy of the file would produce a validly encrypted object holding
 * a prefix plus the whole file (issue #338). The item fails instead, and the next run takes the
 * streamed path from the first chunk.
 *
 * The streamed body is held to the item's size: a response that ends early or runs long would
 * otherwise come back from `download_file_chunked` as a complete file with the wrong bytes. The
 * buffered SharePoint copy this replaced rejected that, and the Range path checks every chunk.
 */
async function* stream_after_ignored_range(
  label: string,
  request: ChunkRequest,
  yielded_chunks: number,
  abort_signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const { url: download_url, item_id, total_bytes } = request;
  if (yielded_chunks > 0) {
    throw new Error(
      `Range requests stopped being honoured for ${label} item ${item_id} after ` +
        `${yielded_chunks} chunk(s); the partial transfer cannot be continued by a whole-file download`,
    );
  }
  logger.warn(
    `Range requests are ignored for ${label} item ${item_id} (HTTP 200 with the full body); ` +
      `falling back to one streamed download`,
  );
  const streamed = stream_whole_file_in_chunks(download_url, item_id, {
    abort_signal,
    chunk_size_bytes: CHUNK_SIZE_BYTES,
    // Same per-chunk budget the Range path uses, applied between reads rather than to the whole
    // transfer, so a stalled body is cut off but a slow one is not (issue #198).
    stall_timeout_ms: compute_chunk_timeout_ms(CHUNK_SIZE_BYTES),
  });
  yield* size_checked_chunks(streamed, item_id, total_bytes);
}

/** Fetches one chunk, retrying transient failures up to MAX_CHUNK_RETRIES times. */
async function download_chunk_with_retry(
  label: string,
  request: ChunkRequest,
  chunk_index: number,
  total_chunks: number,
  abort_signal?: AbortSignal,
): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await download_single_chunk(request, abort_signal);
    } catch (err) {
      // A cancelled run is not a chunk failure. Checked before the classification below, which
      // would otherwise relabel the abort as a failed chunk and have it recorded against the item
      // (issue #344).
      abort_signal?.throwIfAborted();
      // Not retryable and not a failure: the caller switches strategy on it.
      if (err instanceof RangeIgnoredError) throw err;
      // Not retryable: a file that changed size under the transfer answers the same range the same
      // way again. Passed up unwrapped so the failure keeps its type (issue #721).
      if (err instanceof DownloadIntegrityError) throw err;
      if (!is_cdn_retryable(err) || attempt === MAX_CHUNK_RETRIES) {
        const position = `${chunk_index}/${total_chunks} of ${label} item ${request.item_id}`;
        throw new ChunkDownloadError(
          `Failed chunk ${position} after ${attempt + 1} attempts: ${describe_error(err)}`,
          err,
        );
      }

      const delay = compute_chunk_retry_delay(err, attempt);
      logger.debug(
        `Chunk ${chunk_index}/${total_chunks} retry ${attempt + 1}/${MAX_CHUNK_RETRIES} ` +
          `for ${label} item ${request.item_id} in ${(delay / 1000).toFixed(1)}s`,
      );
      // Rejects with the abort reason, so a run cancelled during a 30 second backoff, or during a
      // CDN Retry-After of up to an hour, stops there rather than waiting it out (issue #632).
      await cancellable_sleep(delay, abort_signal);
    }
  }
}

/**
 * Classifies on the status the chunk response carried, through the same rule as every Graph call,
 * so a 500 or 502 is retried and a 404 is not (issue #36). The message is never read: its byte
 * range and item id can contain any status code's digits (issue #618).
 */
function is_cdn_retryable(err: unknown): boolean {
  if (err instanceof CdnHttpError) return is_transient_error({ statusCode: err.status_code });
  return is_retryable_error(err);
}

/** The CDN's Retry-After when it sent one, otherwise exponential backoff with jitter. */
function compute_chunk_retry_delay(err: unknown, attempt: number): number {
  const retry_after_ms = err instanceof CdnHttpError ? err.retry_after_ms : undefined;
  return retry_after_ms ?? compute_retry_delay(attempt);
}

/** The message of an Error, or the stringified value of anything else that was thrown. */
function describe_error(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Exponential backoff from 1 second with up to 1 second of jitter, capped at 30 seconds. */
function compute_retry_delay(attempt: number): number {
  const base = CHUNK_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * CHUNK_BASE_DELAY_MS;
  return Math.min(base + jitter, CHUNK_MAX_DELAY_MS);
}
