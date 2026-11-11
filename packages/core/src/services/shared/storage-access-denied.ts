import {
  has_storage_error_code,
  read_storage_http_status,
} from '@/services/shared/storage-error-fields';

/**
 * Whether a storage error is a permission refusal: HTTP 403 or the S3 `AccessDenied` code.
 *
 * Reads structured fields only, the same rule as `is_access_denied` in the S3 adapter, which core
 * cannot import. The message is never read (issue #658).
 */
export function is_storage_access_denied(err: unknown): boolean {
  return has_storage_error_code(err, ['AccessDenied']) || read_storage_http_status(err) === 403;
}
