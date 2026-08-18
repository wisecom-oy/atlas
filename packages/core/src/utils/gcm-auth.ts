/**
 * Classification of AES-256-GCM authentication-tag failures.
 *
 * Node reports a failed tag check from `decipher.final()` with the exact
 * message below and no error code, so the message is the only signal available.
 * Matching it exactly -- instead of any error mentioning "auth" -- keeps
 * storage authorization/authentication failures out of the tampering bucket:
 * an expired S3 credential must not be reported to an incident responder as a
 * wrong key or modified ciphertext.
 */

/** Node's OpenSSL GCM tag-verification failure message. */
const GCM_AUTH_FAILURE_MESSAGE = 'Unsupported state or unable to authenticate data';

/** Returns whether an error (or any of its causes) is an AES-GCM authentication-tag failure. */
export function is_gcm_auth_failure(err: unknown): boolean {
  for (let current = err, depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current.message === GCM_AUTH_FAILURE_MESSAGE) return true;
    current = current.cause;
  }
  return false;
}
