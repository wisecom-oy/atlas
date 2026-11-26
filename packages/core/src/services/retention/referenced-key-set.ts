import { createHash } from 'node:crypto';

/** Bytes of SHA-256 kept per key: 96 bits, as the Outlook summary rows hash object ids. */
const DIGEST_BYTES = 12;

/**
 * The storage keys an owner's remaining snapshots reference, held as 96-bit digests rather than
 * the keys themselves, so a drive with a million files costs tens of megabytes, not hundreds.
 *
 * A collision can only make an unreferenced key look referenced, and the sweep then keeps it. It
 * can never make a referenced key look unreferenced, so a digest never causes a wrong deletion.
 */
export class ReferencedKeySet {
  private readonly _digests = new Set<string>();

  /** Records one referenced key; an undefined or empty key is ignored. */
  add(key: string | undefined): void {
    if (key) this._digests.add(digest_of(key));
  }

  /** Whether any remaining snapshot may reference the key. */
  has(key: string): boolean {
    return this._digests.has(digest_of(key));
  }

  /** How many distinct keys were recorded. */
  get size(): number {
    return this._digests.size;
  }
}

function digest_of(key: string): string {
  return createHash('sha256').update(key).digest().subarray(0, DIGEST_BYTES).toString('base64');
}
