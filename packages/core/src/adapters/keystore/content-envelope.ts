/**
 * The versioned header that binds a stored object to the place it belongs.
 *
 * One DEK encrypts every object of a tenant and, until this header existed, nothing tied a
 * ciphertext to its key: the GCM tag proved the bytes were produced under the tenant key, not that
 * they are the bytes that belong here, so any object authenticated in any other object's place.
 * Moving one blob over another needed write access to the bucket, not the passphrase (issue #350).
 *
 * Layout: `[MAGIC][version][IV 12][auth tag 16][ciphertext]`. The header itself is part of the
 * AAD, so the version cannot be stripped or lowered without failing the tag, which is the same
 * construction `wrap_dek` already uses for the wrapped DEK.
 *
 * A blob that does not start with the magic is read the way it always was, with no AAD. Every
 * backup written before this change stays readable and no migration step exists.
 */

/** Marks a blob as carrying the versioned, scope-bound envelope. */
export const CONTENT_MAGIC = Buffer.from('ATLS', 'ascii');

/** Current content envelope version. */
export const CONTENT_FORMAT_VERSION = 1;

/** Bytes the header occupies before the IV. */
export const CONTENT_HEADER_LENGTH = CONTENT_MAGIC.length + 1;

/** Builds the header for a newly written object. */
export function build_content_header(): Buffer {
  return Buffer.concat([CONTENT_MAGIC, Buffer.of(CONTENT_FORMAT_VERSION)]);
}

/** Whether a blob, or the first bytes of one, carries the versioned envelope. */
export function has_content_header(blob: Buffer): boolean {
  return (
    blob.length >= CONTENT_HEADER_LENGTH &&
    blob.subarray(0, CONTENT_MAGIC.length).equals(CONTENT_MAGIC)
  );
}

/**
 * Reads and checks the header of a blob that carries one.
 *
 * A version this build does not know is refused rather than guessed at: the layout after the
 * header is what a future version would change.
 */
export function read_content_header(blob: Buffer): Buffer {
  const header = blob.subarray(0, CONTENT_HEADER_LENGTH);
  const version = header[CONTENT_MAGIC.length];
  if (version !== CONTENT_FORMAT_VERSION) {
    throw new Error(
      `Unsupported content envelope version ${String(version)}; this build writes and reads ` +
        `version ${CONTENT_FORMAT_VERSION}`,
    );
  }
  return header;
}

/**
 * The associated data an object is authenticated against: its header and its scope.
 *
 * A `\0` separates the two so a scope cannot be confused with a longer one that starts the same
 * way, which is what would let `onedrive/data/user1/` pass for `onedrive/data/user10/`.
 */
export function content_aad(header: Buffer, scope: string): Buffer {
  return Buffer.concat([header, Buffer.of(0), Buffer.from(scope, 'utf-8')]);
}

/**
 * The scope a storage key belongs to: everything up to and including its last `/`.
 *
 * The directory rather than the whole key, because the large-file pipeline encrypts into a staging
 * key and copies the finished object onto its content-addressed key, so the final key is not known
 * when the cipher is created. The directory names the purpose and the owner, which is what an
 * attacker moving a blob has to defeat; the checksum comparison in restore covers the rest.
 */
export function content_scope(storage_key: string): string {
  const last_separator = storage_key.lastIndexOf('/');
  // A key at the bucket root, `identity-registry.json`, has no directory to name its purpose. The
  // key itself is the scope there: an empty one would make every root object interchangeable,
  // which is the substitution this exists to stop.
  return last_separator === -1 ? storage_key : storage_key.slice(0, last_separator + 1);
}
