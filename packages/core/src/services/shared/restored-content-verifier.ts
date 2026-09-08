import { createHash } from 'node:crypto';

/**
 * Raised when decrypted bytes are not the bytes the manifest recorded for that entry.
 *
 * Separate from a decryption failure on purpose: the bytes authenticated, so the key material and
 * the object are intact. What failed is the claim that this object is the one the manifest points
 * at.
 */
export class RestoredContentMismatchError extends Error {
  constructor(
    readonly label: string,
    readonly expected_checksum: string,
    readonly actual_checksum: string,
  ) {
    super(
      `Restored content for ${label} does not match its manifest checksum ` +
        `(expected ${expected_checksum}, got ${actual_checksum}); refusing to restore it`,
    );
    this.name = 'RestoredContentMismatchError';
  }
}

/**
 * Fails a restore when the decrypted bytes are not what the manifest recorded.
 *
 * Content is encrypted with one tenant key and nothing in the ciphertext says which object it is,
 * so any object in the tenant authenticates in any other object's place. Anyone who can write to
 * the bucket, without the key, can swap two blobs and have a restore put one message's contents
 * where another belongs. The manifest checksum is the only thing that distinguishes them, so it is
 * checked before any side effect rather than after (issue #340).
 *
 * An entry with no recorded checksum cannot be verified and is refused for the same reason: an
 * unverifiable restore is exactly the case the substitution produces.
 */
export function assert_restored_content_matches(
  label: string,
  content: Buffer,
  expected_checksum: string | undefined,
): void {
  const actual = createHash('sha256').update(content).digest('hex');
  if (!expected_checksum) {
    throw new RestoredContentMismatchError(label, '<none recorded>', actual);
  }
  if (actual !== expected_checksum) {
    throw new RestoredContentMismatchError(label, expected_checksum, actual);
  }
}
