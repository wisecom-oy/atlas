import { S3ServiceException } from '@aws-sdk/client-s3';

/** Builds the CopySource value for same-bucket copy (key segments URI-encoded). */
export function build_s3_copy_source(bucket: string, key: string): string {
  const encoded_key = key.split('/').map(encodeURIComponent).join('/');
  return `${bucket}/${encoded_key}`;
}

export function is_precondition_failed(err: unknown): boolean {
  if (err instanceof S3ServiceException) return err.$metadata.httpStatusCode === 412;
  return (err as { name?: string }).name === 'PreconditionFailed';
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

export function is_backend_mode_rejection(err: unknown, mode?: string): boolean {
  if (!mode) return false;
  if (!(err instanceof S3ServiceException)) return false;
  const error_text = `${err.name} ${err.message}`.toLowerCase();
  return (
    error_text.includes('object lock') ||
    error_text.includes('invalidrequest') ||
    error_text.includes('invalidargument')
  );
}
