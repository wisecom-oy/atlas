/**
 * How a file below the streaming threshold is charged when its download began with an expired URL
 * and the refreshed URL and the Graph `/content` fallback failed too (issue #895).
 *
 * The large-file path already records an expired URL without spending one of the file's ledger
 * attempts (issue #718). The smaller paths dropped the cause on the way to the recorder, so the same
 * expiry spent an attempt below 64 MiB. A failure that says something about the file itself keeps
 * its own handling and is charged as before.
 */

import { is_content_gone_error, is_unretryable_download_failure } from '@wisecom/atlas-m365-graph';
import type { DriveDownloadItem } from '@/backup/graph-item-content';
import { DownloadIntegrityError } from '@/backup/download-integrity';
import { DownloadUrlExpiredError, is_download_url_expired } from '@/backup/large-file-url-refresh';
import { is_transient_drive_failure } from '@/backup/transient-download-failure';

/**
 * The error to throw for a `/content` fallback that failed after the URL expired: the failure
 * itself when it carries a classification of its own, otherwise a `DownloadUrlExpiredError`
 * wrapping it, which the caller records without spending an attempt.
 */
export function as_expired_url_failure(item: DriveDownloadItem, err: unknown): unknown {
  if (has_own_classification(err)) return err;
  const reason = err instanceof Error ? err.message : String(err);
  return new DownloadUrlExpiredError(
    `Download URL for ${item.item_id} expired, and the refreshed URL and the Graph /content ` +
      `fallback failed too: ${reason}`,
    err,
  );
}

/**
 * True for a failure the download path already classifies: a body of the wrong length or range
 * and a file that is gone (the file's own, so they spend an attempt), a refusal or missing grant,
 * and a transient failure, which is retried and then spared on its own.
 */
function has_own_classification(err: unknown): boolean {
  return (
    err instanceof DownloadIntegrityError ||
    is_content_gone_error(err) ||
    is_unretryable_download_failure(err) ||
    is_transient_drive_failure(err) ||
    is_download_url_expired(err)
  );
}
