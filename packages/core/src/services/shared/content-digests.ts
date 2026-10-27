import { createHash } from 'node:crypto';
import type { TenantContext } from '@wisecom/atlas-types';

/** Hashing runs in slices: a single Node update over 2 GB fails with ERR_OUT_OF_RANGE. */
const HASH_CHUNK_SIZE = 64 * 1024 * 1024;

export interface ContentDigests {
  /** Plain SHA-256 of the plaintext, recorded in the manifest for integrity checks. */
  readonly checksum: string;
  /** Keyed name the object is stored under: HMAC-SHA256 under the tenant naming key (issue #446). */
  readonly content_name: string;
}

/**
 * Computes the manifest checksum and the storage name of a plaintext buffer in one pass.
 * Streamed uploads compute the same two values incrementally, so both paths name a file alike.
 */
export function compute_content_digests(ctx: TenantContext, plaintext: Buffer): ContentDigests {
  const checksum = createHash('sha256');
  const content_name = ctx.create_content_hmac();
  for (let offset = 0; offset < plaintext.length; offset += HASH_CHUNK_SIZE) {
    const slice = plaintext.subarray(offset, Math.min(offset + HASH_CHUNK_SIZE, plaintext.length));
    checksum.update(slice);
    content_name.update(slice);
  }
  return { checksum: checksum.digest('hex'), content_name: content_name.digest('hex') };
}
