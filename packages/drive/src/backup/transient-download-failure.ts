/**
 * Tells a drive failure that belongs to the service or the network from one that belongs to the
 * file, so the failed-item ledger spends a file's attempts only on the second kind (issue #857).
 *
 * A file gets `MAX_FAILED_ITEM_ATTEMPTS` (5) tries before it is permanently skipped, and the drive
 * checkpoint has already moved past it. A deployment that runs backups several times a day fits
 * five runs inside one Microsoft 365 incident, so counting outage failures against the file
 * dropped every file that failed during the incident from all later snapshots.
 *
 * Classification reuses the rules every Graph call already retries on, and adds the two failure
 * shapes the drive transfer path produces on its own: a CDN status carried as `status_code`, and a
 * `TransferTimeoutError`. Nothing reads the message text.
 */

import { is_retryable_error, is_transient_error } from '@wisecom/atlas-m365-graph';
import { CdnHttpError, ChunkDownloadError } from '@/backup/cdn-chunk-errors';
import {
  is_download_url_expired,
  type DownloadUrlExpiredError,
} from '@/backup/large-file-url-refresh';
import { TransferTimeoutError } from '@/backup/transfer-timeout';

/**
 * How many `cause` links are followed. A chunk failure wraps the attempt's error, which can wrap a
 * socket error, so three is the deepest real chain; the bound stops a cyclic one.
 */
const MAX_CAUSE_DEPTH = 4;

/**
 * A download that failed for a reason outside the file: throttling, Graph 5xx after its retries, a
 * reset or timeout, or a download host that was down. The file is recorded for the next run
 * without spending one of its attempts. The original failure is kept as `cause`.
 */
export class TransientDownloadError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'TransientDownloadError';
  }
}

/** True for the error that means a download failed for a reason outside the file. */
export function is_transient_download_error(err: unknown): err is TransientDownloadError {
  return err instanceof TransientDownloadError;
}

/**
 * True when a failed download or item read says nothing about the file: a transient Graph status
 * or an exhausted Graph retry (`GraphUnavailableError`, `ThrottledError`), a network or token
 * failure, a transient CDN status, or a transfer that timed out. A size or checksum mismatch and a
 * 4xx that is not throttling are the file's own and return false. Never throws, whatever it is
 * handed: a thrown value that is not an object carries nothing to classify and returns false.
 */
export function is_transient_drive_failure(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  if (is_retryable_error(err)) return true;
  return error_and_causes(err).some(
    (link) => link instanceof TransferTimeoutError || has_transient_cdn_status(link),
  );
}

/**
 * The `TransientDownloadError` to throw for a failure outside the file, or undefined when the
 * failure is the file's own and should spend an attempt.
 */
export function transient_download_error_for(
  err: unknown,
  file_label: string,
): TransientDownloadError | undefined {
  if (!is_transient_drive_failure(err)) return undefined;
  const reason = err instanceof Error ? err.message : String(err);
  return new TransientDownloadError(
    `Download of ${file_label} failed for a reason outside the file and is retried by the next ` +
      `run without spending an attempt: ${reason}`,
    err,
  );
}

/**
 * True for a download failure the caller records without spending one of the file's ledger
 * attempts: an expired download URL (issue #718) or a transient failure.
 */
export function spares_failed_item_attempt(
  err: unknown,
): err is DownloadUrlExpiredError | TransientDownloadError {
  return is_download_url_expired(err) || is_transient_download_error(err);
}

/** A CDN answer of 429 or a transient 5xx, judged by the same status rule as a Graph call. */
function has_transient_cdn_status(link: unknown): boolean {
  if (!(link instanceof CdnHttpError || link instanceof ChunkDownloadError)) return false;
  const status = link.status_code;
  return status !== undefined && is_transient_error({ statusCode: status });
}

/** The error followed by its `cause` chain, stopping at a cycle or the depth bound. */
function error_and_causes(err: unknown): unknown[] {
  const links: unknown[] = [];
  let current = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (current === null || typeof current !== 'object' || links.includes(current)) break;
    links.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return links;
}
