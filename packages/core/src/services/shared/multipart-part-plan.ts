/**
 * Part sizing for the encrypted multipart stream (issue #925).
 *
 * S3 accepts at most 10,000 parts per multipart upload, so a fixed part size caps the object: at
 * 8 MiB a file over 78.1 GiB uploaded 10,000 parts and then failed on part 10,001. The part size is
 * now derived from the size the file was listed with, in steps of 8 MiB, so the smallest file still
 * uses 8 MiB parts and the part count stays within the limit.
 *
 * The part size is also the memory bound: one part is held back until the cipher is finalised and
 * one more is in flight, so a stream retains about two parts. The 32 MiB ceiling covers Microsoft
 * 365's 250 GB file limit whether that is read as decimal or binary gigabytes, and keeps that bound
 * near 64 MiB, half of what the buffered path below the large-file threshold may hold.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Parts S3 accepts in one multipart upload. */
export const MAX_MULTIPART_PARTS = 10_000;

/** Smallest part size, and the step every planned part size is a multiple of. */
export const PART_SIZE_STEP_BYTES = 8 * MIB;

/** Largest part size a stream may use, which bounds its retained memory at about twice this. */
export const MAX_PART_SIZE_BYTES = 32 * MIB;

/** Why a stream was refused: its listed size, or the bytes it actually delivered. */
export enum PartLimitBreach {
  LISTED_SIZE = 'listed_size',
  STREAM_OVERFLOW = 'stream_overflow',
}

/**
 * A stream that needs more parts than the backend accepts.
 *
 * `LISTED_SIZE` is raised before the multipart upload starts, so no part is uploaded and retrying
 * the same file cannot help. `STREAM_OVERFLOW` is raised when the stream delivered more bytes than
 * its plan holds, before the part past the limit is uploaded.
 */
export class MultipartPartLimitError extends Error {
  constructor(
    message: string,
    readonly breach: PartLimitBreach,
    readonly part_limit: number,
    readonly part_size_bytes: number,
  ) {
    super(message);
    this.name = 'MultipartPartLimitError';
  }
}

/** True for a file refused by its listed size, before any part was uploaded. */
export function is_listed_size_part_limit_refusal(err: unknown): err is MultipartPartLimitError {
  return err instanceof MultipartPartLimitError && err.breach === PartLimitBreach.LISTED_SIZE;
}

/** Largest object a stream can carry within `part_limit` parts. */
export function max_streamed_object_bytes(part_limit: number = MAX_MULTIPART_PARTS): number {
  return MAX_PART_SIZE_BYTES * part_limit;
}

/**
 * The smallest multiple of {@link PART_SIZE_STEP_BYTES} that carries `listed_bytes` within
 * `part_limit` parts. An unknown size (zero or less) plans the smallest part.
 *
 * @throws MultipartPartLimitError when even {@link MAX_PART_SIZE_BYTES} parts would not fit.
 */
export function plan_multipart_part_size(
  listed_bytes: number,
  part_limit: number = MAX_MULTIPART_PARTS,
): number {
  if (listed_bytes > max_streamed_object_bytes(part_limit)) {
    throw new MultipartPartLimitError(
      `File is ${describe_bytes(listed_bytes)}, larger than the ` +
        `${describe_bytes(max_streamed_object_bytes(part_limit))} Atlas can upload: S3 accepts ` +
        `at most ${part_limit} parts per multipart upload and Atlas uses parts of at most ` +
        `${MAX_PART_SIZE_BYTES / MIB} MiB`,
      PartLimitBreach.LISTED_SIZE,
      part_limit,
      MAX_PART_SIZE_BYTES,
    );
  }
  const steps_per_part = Math.ceil(listed_bytes / (part_limit * PART_SIZE_STEP_BYTES));
  return Math.max(1, steps_per_part) * PART_SIZE_STEP_BYTES;
}

/**
 * Refuses a file too large for any part size Atlas uses, so a caller can stop before it opens a
 * download it would never finish.
 *
 * @throws MultipartPartLimitError as {@link plan_multipart_part_size} does.
 */
export function assert_listed_size_fits_part_limit(
  listed_bytes: number,
  part_limit: number = MAX_MULTIPART_PARTS,
): void {
  plan_multipart_part_size(listed_bytes, part_limit);
}

/**
 * Fails a stream that has delivered more bytes than `part_limit` parts of `part_size_bytes` hold.
 *
 * Called as the bytes arrive, so a file that grew past its listed size is stopped before the part
 * past the limit is uploaded instead of failing on it at the backend.
 */
export function assert_stream_within_part_limit(
  streamed_bytes: number,
  part_size_bytes: number,
  part_limit: number = MAX_MULTIPART_PARTS,
): void {
  const capacity = part_size_bytes * part_limit;
  if (streamed_bytes <= capacity) return;
  throw new MultipartPartLimitError(
    `Stream delivered more than the ${describe_bytes(capacity)} its upload was planned for: ` +
      `S3 accepts at most ${part_limit} parts per multipart upload and this upload uses ` +
      `${part_size_bytes / MIB} MiB parts. The file is larger than its listed size`,
    PartLimitBreach.STREAM_OVERFLOW,
    part_limit,
    part_size_bytes,
  );
}

/** Exact bytes for the record, with GiB for the reader: `268435456000 bytes (250.0 GiB)`. */
function describe_bytes(bytes: number): string {
  return `${bytes} bytes (${(bytes / GIB).toFixed(1)} GiB)`;
}
