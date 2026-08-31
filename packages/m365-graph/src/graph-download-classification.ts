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
 * - The service will not release the item (IRM, sensitivity label, policy).
 *   Neither a refresh nor a second download budget changes the answer, so the
 *   item is recorded against the snapshot and the run continues.
 *
 * Classification keys on the transport the error came from and on the Graph error
 * code, never on the message text. Microsoft's own error guidance is explicit
 * that `message` "can change at any time" and that callers "should only code
 * against error codes returned in `code` properties", which is why the previous
 * substring test on `Forbidden` and `Unauthorized` is gone: it also matched
 * wrapped storage and proxy errors that had nothing to do with the download URL.
 */

/** Cause of a failed download, as far as the error itself can be trusted to say. */
export type DownloadFailureKind =
  /** A pre-authenticated CDN URL that is no longer valid: re-resolve and retry. */
  | 'expired_url'
  /** The application lacks a required Graph permission: stop and name it. */
  | 'missing_permission'
  /** The service refuses to release this item and will keep refusing. */
  | 'service_refused'
  /** Graph rejected the credential itself, which a URL refresh cannot fix. */
  | 'unauthorized'
  /** Nothing in the error identifies a cause; the caller falls back as before. */
  | 'unclassified';

/**
 * Graph error codes that mean the application is missing a grant. Only these abort
 * a run: any other 403 code is treated as a per-item refusal, because aborting a
 * whole tenant backup on an unrecognised code is the worse failure.
 *
 * Both spellings are real: driveItem returns `accessDenied`, while the Exchange
 * backed APIs return `ErrorAccessDenied`.
 */
const MISSING_PERMISSION_CODES = new Set(['accessdenied', 'erroraccessdenied']);

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

/** Thrown when a download fails because the app registration lacks a grant. */
export class MissingGraphPermissionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingGraphPermissionsError';
  }
}

/** Classifies a caught download error. Never throws, whatever it is handed. */
export function classify_download_failure(err: unknown): DownloadFailureKind {
  if (err === null || typeof err !== 'object') return 'unclassified';

  const candidate = err as { status_code?: unknown; statusCode?: unknown; code?: unknown };

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
    return MISSING_PERMISSION_CODES.has(code) ? 'missing_permission' : 'service_refused';
  }

  return 'unclassified';
}

/** Reads the Graph error code, for naming a refusal the operator has to investigate. */
export function read_graph_error_code(err: unknown): string {
  if (err === null || typeof err !== 'object') return 'unknown';
  const code = (err as { code?: unknown }).code;
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
