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
 * Fails a `206` that does not deliver exactly the requested range.
 *
 * RFC 9110 requires `Content-Range` on a partial response, so a missing header is itself a reason
 * to distrust the body: without it there is nothing to say which bytes of the file arrived, and a
 * server answering every range with the same chunk would be indistinguishable from a correct one.
 */
export function assert_range_chunk(
  item_id: string,
  range_start: number,
  range_end: number,
  content_range: string | null,
  body_length: number,
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

/** Parses the `bytes <start>-<end>/<size>` form; anything else, including `*`, is unusable. */
function parse_content_range(header: string | null): { start: number; end: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(header?.trim() ?? '');
  if (!match) return undefined;
  return { start: Number(match[1]), end: Number(match[2]) };
}
