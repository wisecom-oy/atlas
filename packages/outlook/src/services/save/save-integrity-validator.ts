import { createHash, timingSafeEqual } from 'node:crypto';

/** Returns the SHA-256 hex digest of the given buffer. */
export function compute_sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compares a buffer's SHA-256 against an expected hex digest.
 * Uses constant-time comparison when lengths match to prevent timing attacks.
 */
export function verify_checksum(data: Buffer, expected_checksum: string): boolean {
  const actual = compute_sha256(data);
  if (actual.length !== expected_checksum.length) return false;

  const actual_buf = Buffer.from(actual, 'utf8');
  const expected_buf = Buffer.from(expected_checksum, 'utf8');
  return timingSafeEqual(actual_buf, expected_buf);
}
