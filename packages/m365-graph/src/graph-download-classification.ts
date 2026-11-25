/**
 * Classifies a failed drive-file download by cause, so a 403 is acted on for the
 * reason it was returned (issue #246).
 *
 * Three unrelated conditions answer 403 on this path, and the previous code read
 * all of them as an expired pre-authenticated URL:
 *
 * - The pre-authenticated download URL really has expired. Re-resolving and
 *   retrying is correct, and this is the only case where it is.
 * - The tenant has not granted the application permission. Re-resolving cannot
 *   help, and the run should stop and name the missing grant.
 * - The service will not release the item (malware, IRM, sensitivity label).
 *   Neither a refresh nor a second download budget changes the answer, so the
 *   item is recorded against the snapshot and the run continues.
 *
 * A 403 whose code names none of these is a fourth case. Nothing says it will
 * last, so the item fails for this run and is retried by the next one, within
 * the failed-item attempt budget (issue #866).
 *
 * Classification keys on the transport the error came from and on the Graph error
 * code, never on the message text. Microsoft's own error guidance is explicit
 * that `message` "can change at any time" and that callers "should only code
 * against error codes returned in `code` properties", which is why the previous
 * substring test on `Forbidden` and `Unauthorized` is gone: it also matched
 * wrapped storage and proxy errors that had nothing to do with the download URL.
 */

import { MissingGraphPermissionsError } from '@wisecom/atlas-types';

/** Cause of a failed download, as far as the error itself can be trusted to say. */
export type DownloadFailureKind =
  /** A pre-authenticated CDN URL that is no longer valid: re-resolve and retry. */
  | 'expired_url'
  /** The application lacks a required Graph permission: stop and name it. */
  | 'missing_permission'
  /** The service refuses to release this item and will keep refusing. */
  | 'service_refused'
  /** A Graph 403 whose code names no known cause: fail the item now, retry it next run. */
  | 'unrecognised_refusal'
  /** Graph rejected the credential itself, which a URL refresh cannot fix. */
  | 'unauthorized'
  /** Nothing in the error identifies a cause; the caller falls back as before. */
  | 'unclassified';

/**
 * Graph error codes that mean the application is missing a grant. Only these abort
 * a run, because aborting a whole tenant backup on an unrecognised code is the
 * worse failure.
 *
 * Both spellings are real: driveItem returns `accessDenied`, while the Exchange
 * backed APIs return `ErrorAccessDenied`.
 */
const MISSING_PERMISSION_CODES = new Set(['accessdenied', 'erroraccessdenied']);

/**
 * Graph error codes that mean the service will never release this item's content. Only these are
 * recorded as permanent on the first 403. Any other code, or none, fails the item for one run and
 * leaves it to the attempt budget, so one transient or misread 403 cannot hide a file for good.
 *
 * - `malwareDetected`: the content is quarantined by Microsoft 365 malware policy.
 * - `fileDoubleKeyEncrypted`, `fileDecryptionNotSupported`: a sensitivity label encrypts the
 *   content in a way the service cannot decrypt for the caller.
 *
 * Keep this list in step with "When a file cannot be backed up" in `docs/onedrive-backup.md` and
 * `docs/sharepoint-backup.md`.
 */
const PERMANENT_REFUSAL_CODES = new Set([
  'malwaredetected',
  'filedoublekeyencrypted',
  'filedecryptionnotsupported',
]);

/** Thrown for a 403 the service will not reverse. Permanent for the item, not the run. */
export class DownloadRefusedError extends Error {
  constructor(
    message: string,
    readonly graph_code: string,
  ) {
    super(message);
    this.name = 'DownloadRefusedError';
  }
}

/**
 * Thrown when the app registration lacks a grant. Defined with the other Atlas errors, so the SDK
 * exports it and it carries `ATLAS_AUTH_DENIED` (issue #772); re-exported here for its callers.
 */
export { MissingGraphPermissionsError };

/**
 * How many `cause` links are followed looking for a status. A wrapper around a wrapper is the most
 * any download path builds; the bound only stops a cyclic chain from looping.
 */
const MAX_CAUSE_DEPTH = 4;

/**
 * The first error in the `cause` chain that carries an HTTP status, or the error itself when none
 * does. A chunk that fails for good is rethrown with the attempt's error as its `cause`, and
 * reading only the outer error is what left a chunked 403 unclassified (issue #632).
 */
function find_status_carrier(err: unknown): unknown {
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (current === null || typeof current !== 'object') return err;
    const candidate = current as { status_code?: unknown; statusCode?: unknown; cause?: unknown };
    if (typeof candidate.status_code === 'number' || typeof candidate.statusCode === 'number') {
      return current;
    }
    current = candidate.cause;
  }
  return err;
}

/** Classifies a caught download error. Never throws, whatever it is handed. */
export function classify_download_failure(err: unknown): DownloadFailureKind {
  const carrier = find_status_carrier(err);
  if (carrier === null || typeof carrier !== 'object') return 'unclassified';

  const candidate = carrier as { status_code?: unknown; statusCode?: unknown; code?: unknown };

  // A CDN error carries `status_code` and comes from fetching the pre-authenticated
  // URL, which is the one place a 403 does mean the URL went stale.
  if (typeof candidate.status_code === 'number') {
    return candidate.status_code === 401 || candidate.status_code === 403
      ? 'expired_url'
      : 'unclassified';
  }

  // A Graph error carries `statusCode` and comes from the API, where 401 and 403
  // mean different things and must not share a branch.
  if (typeof candidate.statusCode === 'number') {
    if (candidate.statusCode === 401) return 'unauthorized';
    if (candidate.statusCode !== 403) return 'unclassified';
    const code = typeof candidate.code === 'string' ? candidate.code.toLowerCase() : '';
    if (MISSING_PERMISSION_CODES.has(code)) return 'missing_permission';
    return PERMANENT_REFUSAL_CODES.has(code) ? 'service_refused' : 'unrecognised_refusal';
  }

  return 'unclassified';
}

/** Reads the Graph error code, for naming a refusal the operator has to investigate. */
export function read_graph_error_code(err: unknown): string {
  const carrier = find_status_carrier(err);
  if (carrier === null || typeof carrier !== 'object') return 'unknown';
  const code = (carrier as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : 'unknown';
}

/** True for a refusal that must be recorded against the item rather than retried. */
export function is_download_refused(err: unknown): err is DownloadRefusedError {
  return err instanceof DownloadRefusedError;
}

/** True for a missing-grant failure, which must abort the run rather than skip an item. */
export function is_missing_graph_permissions(err: unknown): err is MissingGraphPermissionsError {
  return err instanceof MissingGraphPermissionsError;
}

/** True when an error must reach the caller intact instead of becoming a silent skip. */
export function is_unretryable_download_failure(err: unknown): boolean {
  return is_download_refused(err) || is_missing_graph_permissions(err);
}
