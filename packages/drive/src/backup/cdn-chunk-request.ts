import {
  parse_retry_after_ms,
  report_transfer_throttle,
  wait_for_transfer_slot,
} from '@wisecom/atlas-m365-graph';
import { assert_range_chunk } from '@/backup/download-integrity';
import { CdnHttpError, RangeIgnoredError } from '@/backup/cdn-chunk-errors';
import { discard_response_body } from '@/backup/response-body';

/** Maximum bytes per HTTP Range chunk (4 MiB). */
export const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

const MIN_THROUGHPUT_BYTES_PER_MS = 256;

/** Calculates a dynamic timeout scaled to the expected transfer size, never below 30 seconds. */
export function compute_chunk_timeout_ms(chunk_bytes: number): number {
  return Math.max(30_000, Math.ceil(chunk_bytes / MIN_THROUGHPUT_BYTES_PER_MS));
}

/** One Range request against a pre-authenticated download URL. */
export interface ChunkRequest {
  readonly url: string;
  readonly item_id: string;
  readonly range_start: number;
  /** Inclusive, as the Range header writes it. */
  readonly range_end: number;
  readonly total_bytes: number;
  /** True when the file spans several chunks, so a 200 means the server ignored Range. */
  readonly report_ignored_range: boolean;
}

/**
 * Fetches one chunk, once. Throws `CdnHttpError` for an unusable status, `RangeIgnoredError` when
 * the server answered with the whole file, and the run's abort reason when it was cancelled.
 */
export async function download_single_chunk(
  request: ChunkRequest,
  abort_signal?: AbortSignal,
): Promise<Buffer> {
  const { url, item_id, range_start, range_end, total_bytes } = request;
  const expected_length = range_end - range_start + 1;
  // Before the per-chunk timer is armed, so a cooldown is not counted against the chunk budget.
  await wait_for_transfer_slot(abort_signal);
  // Scaled to this chunk, not to the file. Passing total_bytes here gave every
  // non-final chunk a ceil(total_bytes / 256) ms budget, so one stalled CDN
  // connection held a 1 GB backup for ~68 minutes before aborting (issue #198).
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), compute_chunk_timeout_ms(expected_length));
  // One listener, removed below, rather than `AbortSignal.any` per chunk: the run's signal outlives
  // every chunk, and Node keeps a dependent entry for each composite until the source aborts, which
  // is 256 of them per GiB transferred (issue #344).
  const cancel_chunk = (): void => controller.abort(abort_signal?.reason);
  abort_signal?.addEventListener('abort', cancel_chunk, { once: true });

  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=${range_start}-${range_end}` },
      signal: controller.signal,
    });
    report_transfer_throttle(response);
    if (response.status !== 206 && response.status !== 200) {
      // Never read, so cancelled to free the connection before the chunk is retried or failed.
      await discard_response_body(response);
      throw chunk_status_error(response, request);
    }

    if (response.status === 200 && request.report_ignored_range) {
      // Drop the body unread: buffering a whole file per chunk is the cost this avoids.
      await discard_response_body(response);
      throw new RangeIgnoredError();
    }

    // A single-chunk item legitimately comes back as a 200 with the whole file, whose body is
    // total_bytes rather than one chunk, so it gets the whole-file budget before it is drained.
    if (response.status === 200) {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), compute_chunk_timeout_ms(total_bytes));
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (response.status === 200) return slice_whole_file_body(buf, request);

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
    abort_signal?.removeEventListener('abort', cancel_chunk);
  }
}

/** The `CdnHttpError` for a chunk answered with an unusable status, with Retry-After on a 429. */
function chunk_status_error(response: Response, request: ChunkRequest): CdnHttpError {
  const range = `bytes=${request.range_start}-${request.range_end}`;
  const retry_after_ms =
    response.status === 429 ? parse_retry_after_ms(response.headers.get('Retry-After')) : undefined;
  return new CdnHttpError(
    `HTTP ${response.status} for chunk ${range} of ${request.item_id}`,
    response.status,
    retry_after_ms,
  );
}

/**
 * Cuts the requested range out of a 200 body. Anything other than the whole file means the body
 * is not what the slice offsets assume (issue #338).
 */
function slice_whole_file_body(buf: Buffer, request: ChunkRequest): Buffer {
  if (buf.length !== request.total_bytes) {
    throw new CdnHttpError(
      `CDN returned 200 with ${buf.length} bytes for ${request.item_id}, ` +
        `expected ${request.total_bytes}`,
      200,
    );
  }
  return buf.subarray(request.range_start, request.range_end + 1);
}
