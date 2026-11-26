import { S3ServiceException } from '@aws-sdk/client-s3';

/** Builds the CopySource value for same-bucket copy (key segments URI-encoded). */
export function build_s3_copy_source(bucket: string, key: string): string {
  const encoded_key = key.split('/').map(encodeURIComponent).join('/');
  return `${bucket}/${encoded_key}`;
}

/**
 * A conditional write whose condition did not hold. Covers the 412 for a stale `If-Match` or an
 * existing key under `If-None-Match`, and the 409 `ConditionalRequestConflict` S3 answers when two
 * conditional writes to one key arrive at the same moment. Both mean "re-read and try again".
 */
export function is_precondition_failed(err: unknown): boolean {
  const name = (err as { name?: string }).name;
  if (name === 'PreconditionFailed' || name === 'ConditionalRequestConflict') return true;
  if (!(err instanceof S3ServiceException)) return false;
  const status = err.$metadata.httpStatusCode;
  return status === 412 || (status === 409 && err.name === 'ConditionalRequestConflict');
}

/**
 * The credentials lack a permission. Checked on the 403 status as well as the code, because some
 * S3-compatible backends answer a missing list permission with a bare 403.
 */
export function is_access_denied(err: unknown): boolean {
  if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 403) return true;
  return err instanceof Error && err.name === 'AccessDenied';
}

/**
 * True only for errors that name Object Lock as the reason a delete was refused.
 *
 * Backends word it differently: MinIO raises `InvalidRequest` "Object is WORM protected and
 * cannot be overwritten", AWS raises `AccessDenied` "Access Denied because object protected by
 * object lock". Both name the mechanism. A bare `AccessDenied` from a missing IAM permission does
 * not, and must not be filed as "retained, deletable once retention expires": on an erasure
 * report a false alarm costs an investigation, a false all-clear costs the erasure.
 *
 * The wording heuristic lives here, at the boundary that speaks S3, so callers can branch on
 * `ObjectLockRetainedError` instead of grepping messages of their own (issue #40).
 */
export function is_object_lock_refusal(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name} ${err.message}`.toLowerCase() : '';
  return (
    message.includes('object lock') ||
    message.includes('objectlock') ||
    message.includes('worm protected') ||
    message.includes('retention') ||
    message.includes('legal hold')
  );
}

/** True when the error text names Object Lock: the only signal that a rejection is about the lock. */
export function names_object_lock(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const text = `${err.name} ${err.message}`.toLowerCase();
  return text.includes('object lock') || text.includes('objectlock');
}

/** True when the backend rejected a retention mode and the rejection names Object Lock. */
export function is_backend_mode_rejection(err: unknown, mode?: string): boolean {
  if (!mode) return false;
  if (!(err instanceof S3ServiceException)) return false;
  return names_object_lock(err);
}

/** Error codes a backend answers `DeleteObjects` with when it does not take the bulk request. */
const BULK_DELETE_UNSUPPORTED_CODES = new Set([
  'NotImplemented',
  'MethodNotAllowed',
  'MissingContentMD5',
  'InvalidDigest',
  'BadDigest',
]);

/**
 * True when a whole `DeleteObjects` request was refused because the backend does not support it
 * or does not accept its integrity headers, so the same targets can be deleted one at a time.
 *
 * Matches HTTP 501 and 405, the codes above, and a 400 whose message names Content-MD5 or a
 * checksum header. Nothing was deleted by a refused request, so retrying singly is safe. Anything
 * else, a 403 included, is a real failure and propagates.
 */
export function is_bulk_delete_unsupported(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (BULK_DELETE_UNSUPPORTED_CODES.has(err.name)) return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (status === 501 || status === 405) return true;
  const text = err.message.toLowerCase();
  return status === 400 && (text.includes('content-md5') || text.includes('checksum'));
}
