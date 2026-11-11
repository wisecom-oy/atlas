/**
 * Whether a storage error is a refused conditional write (HTTP 412).
 *
 * Core cannot import the S3 adapter's `PreconditionFailedError`, so this matches on the shape every
 * backend produces: the adapter's error name, the raw S3 `PreconditionFailed` code, or a message
 * naming the precondition or the status.
 */
export function is_precondition_failure(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  if (name === 'PreconditionFailedError' || name === 'PreconditionFailed') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /precondition|412/i.test(message);
}
