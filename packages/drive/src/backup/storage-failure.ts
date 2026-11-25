/**
 * Tells a failure of the backup's own storage from a failure of the file being stored (issue #917).
 *
 * A file of 64 MiB or more is streamed from its download straight into a multipart upload, so a
 * full disk, an exceeded quota, an S3 `5xx` after the SDK's retries, or a refused completion or
 * copy leaves through the same call as a failed download. Treated as the file's fault, it went
 * into the failed-item ledger and spent one of the file's five attempts on every run, until a file
 * that never failed was permanently skipped.
 *
 * Recognised by type and structured field only, never the message: a `StorageError`, which the S3
 * adapter raises for a refused or malformed write; a `StorageUnavailableError`, raised when the
 * endpoint never answered; or an S3 answer, which carries `$metadata.httpStatusCode`. Any link of
 * the `cause` chain counts, so a `ConfigError` wrapping a refused lock mode is one too. A download
 * failure carries none of these: Graph and CDN errors keep their status on `statusCode`.
 */

import { read_storage_http_status } from '@wisecom/atlas-core/services/shared/storage-error-fields';
import { StorageError, StorageUnavailableError } from '@wisecom/atlas-types';

/** How many `cause` links are followed; the bound also stops a cyclic chain. */
const MAX_CAUSE_DEPTH = 4;

/** True when the error, or one of its causes, came from the storage backend. */
export function is_storage_failure(err: unknown): boolean {
  let current = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (current === null || typeof current !== 'object') return false;
    if (is_storage_failure_link(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** One link of the chain, judged on its own type and `$metadata`. */
function is_storage_failure_link(link: object): boolean {
  if (link instanceof StorageError || link instanceof StorageUnavailableError) return true;
  return read_storage_http_status(link) !== undefined;
}
