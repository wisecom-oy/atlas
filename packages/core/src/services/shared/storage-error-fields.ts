/**
 * Structured fields of a storage error, read without importing the S3 adapter.
 *
 * Core cannot depend on `@wisecom/atlas-s3` (the adapter depends on core), so these read the shape
 * the AWS SDK and the adapter produce: `$metadata.httpStatusCode`, `name`, and the raw S3 `Code`.
 * Nothing here reads the message, because an object key, a byte count, or a request ID in the
 * message text can contain any status number (issue #658).
 */

type ErrorFields = Record<string, unknown>;

function as_fields(err: unknown): ErrorFields | undefined {
  return err !== null && typeof err === 'object' ? (err as ErrorFields) : undefined;
}

/** Returns the HTTP status from `$metadata.httpStatusCode`, or undefined when there is none. */
export function read_storage_http_status(err: unknown): number | undefined {
  const metadata = as_fields(as_fields(err)?.$metadata);
  const status = metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

/** Whether the error's `name` or raw S3 `Code` equals one of the given codes. */
export function has_storage_error_code(err: unknown, codes: readonly string[]): boolean {
  const fields = as_fields(err);
  if (fields === undefined) return false;
  return [fields.name, fields.Code].some(
    (value) => typeof value === 'string' && codes.includes(value),
  );
}
