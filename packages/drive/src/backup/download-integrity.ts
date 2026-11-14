/**
 * Length checks for downloaded drive content.
 *
 * A backup that hashes whatever arrived cannot detect a truncated transfer: the SHA-256 is computed
 * over the received bytes, so a one byte body produces a perfectly valid checksum for one byte, and
 * AES-GCM authenticates that byte just as happily. The only defence is an expectation formed before
 * the transfer, from the range that was requested and the size Graph reported (issue #338).
 */

/** Raised when a transfer delivered something other than the bytes that were asked for. */
export class DownloadIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadIntegrityError';
  }
}

/**
 * Fails a `206` that does not deliver exactly the requested range, or that comes from a file of a
 * different size than the transfer was planned with.
 *
 * RFC 9110 requires `Content-Range` on a partial response, so a missing header is itself a reason
 * to distrust the body: without it there is nothing to say which bytes of the file arrived, and a
 * server answering every range with the same chunk would be indistinguishable from a correct one.
 *
 * The total is compared with `planned_total_bytes`, the size the ranges were cut from. A file that
 * grew after its delta listing still answers each range correctly, so only the total reveals that
 * the other ranges no longer describe the same file (issue #721). A total of `*` is not compared.
 */
export function assert_range_chunk(
  item_id: string,
  range_start: number,
  range_end: number,
  content_range: string | null,
  body_length: number,
  planned_total_bytes: number,
): void {
  const expected_length = range_end - range_start + 1;
  if (body_length !== expected_length) {
    throw new DownloadIntegrityError(
      `Range bytes=${range_start}-${range_end} of ${item_id} returned ${body_length} bytes, ` +
        `expected ${expected_length}`,
    );
  }

  const satisfied = parse_content_range(content_range);
  if (!satisfied) {
    throw new DownloadIntegrityError(
      `Range bytes=${range_start}-${range_end} of ${item_id} came back without a usable ` +
        `Content-Range header (got ${content_range ?? 'none'})`,
    );
  }
  if (satisfied.start !== range_start || satisfied.end !== range_end) {
    throw new DownloadIntegrityError(
      `Range bytes=${range_start}-${range_end} of ${item_id} was answered with ` +
        `bytes ${satisfied.start}-${satisfied.end}`,
    );
  }
  if (satisfied.total !== undefined && satisfied.total !== planned_total_bytes) {
    throw new DownloadIntegrityError(
      `Range bytes=${range_start}-${range_end} of ${item_id} came from a ${satisfied.total} byte ` +
        `file, but the transfer was planned for ${planned_total_bytes} bytes`,
    );
  }
}

/**
 * Fails a transfer whose byte count does not match the size Graph reported for the item.
 *
 * A reported size of zero means the delta page carried no `size` field, so there is no expectation
 * to check against and the transfer is accepted as-is.
 */
export function assert_transferred_size(
  item_id: string,
  transferred_bytes: number,
  expected_bytes: number,
): void {
  if (expected_bytes <= 0 || transferred_bytes === expected_bytes) return;
  throw new DownloadIntegrityError(
    `Download of ${item_id} produced ${transferred_bytes} bytes, expected ${expected_bytes}`,
  );
}

/**
 * Passes chunks straight through, then fails the transfer if they did not add up to the expected
 * size.
 *
 * The last point where a truncated, duplicated or restarted stream can still be caught: past it the
 * bytes have a checksum and an auth tag of their own, and nothing downstream knows how many there
 * should have been (issue #338). Throwing here aborts a staged multipart upload, so no canonical
 * object is promoted and no manifest entry is written.
 */
export async function* size_checked_chunks(
  chunks: AsyncIterable<Buffer>,
  item_id: string,
  expected_bytes: number,
): AsyncGenerator<Buffer> {
  let transferred = 0;
  for await (const chunk of chunks) {
    transferred += chunk.length;
    yield chunk;
  }
  assert_transferred_size(item_id, transferred, expected_bytes);
}

/**
 * Parses the `bytes <start>-<end>/<total>` form. The total is undefined when the server sends `*`,
 * which is a valid answer that says nothing about the file's size; anything else is unusable.
 */
function parse_content_range(
  header: string | null,
): { start: number; end: number; total: number | undefined } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header?.trim() ?? '');
  if (!match) return undefined;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? undefined : Number(match[3]),
  };
}
