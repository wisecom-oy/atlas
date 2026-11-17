import {
  has_storage_error_code,
  read_storage_http_status,
} from '@/services/shared/storage-error-fields';

const PRECONDITION_CODES = ['PreconditionFailedError', 'PreconditionFailed'];

/**
 * Whether a storage error is a refused conditional write (HTTP 412).
 *
 * Core cannot import the S3 adapter's `PreconditionFailedError`, so this matches on the shape every
 * backend produces: the adapter's error name, the raw S3 `PreconditionFailed` code, or a 412
 * status. The message is never read: a 500 whose text happens to contain "412" is not a refused
 * write (issue #658).
 */
export function is_precondition_failure(err: unknown): boolean {
  return has_storage_error_code(err, PRECONDITION_CODES) || read_storage_http_status(err) === 412;
}
