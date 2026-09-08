/**
 * Whether a storage error means "no such object or bucket" rather than a real failure.
 *
 * The distinction is load-bearing for anything that reads an encrypted object: absence is a normal
 * outcome and a decryption failure is not, and collapsing both into `undefined` reports a damaged
 * backup as one that was never taken (issue #341).
 */
export function is_absent_object_error(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NoSuchKey' || name === 'NoSuchBucket' || name === 'NotFound';
}
