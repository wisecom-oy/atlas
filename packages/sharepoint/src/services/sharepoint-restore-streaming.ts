import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { TenantContext, SharePointManifestEntry } from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const HEADER_LENGTH = IV_LENGTH + AUTH_TAG_LENGTH;

interface StreamDecryptResult {
  content: Buffer;
  sha256_hex: string;
}

/**
 * Reads encrypted data from S3 as a stream, decrypts via AES-256-GCM,
 * and computes SHA-256 incrementally.
 */
export async function stream_decrypt_from_storage(
  ctx: TenantContext,
  storage_key: string,
): Promise<StreamDecryptResult> {
  const raw_stream = await ctx.storage.get_stream(storage_key);
  const readable =
    raw_stream instanceof Readable
      ? raw_stream
      : Readable.from(raw_stream as AsyncIterable<Buffer>);

  const header = await read_exact_bytes(readable, HEADER_LENGTH);
  const iv = header.subarray(0, IV_LENGTH);
  const auth_tag = header.subarray(IV_LENGTH, HEADER_LENGTH);
  const decipher = ctx.create_decipher(iv, auth_tag);
  const sha256 = createHash('sha256');
  const plaintext_chunks: Buffer[] = [];

  for await (const chunk of readable) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    const decrypted = decipher.update(buf);
    if (decrypted.length > 0) {
      plaintext_chunks.push(decrypted);
      sha256.update(decrypted);
    }
  }

  const final_block = decipher.final();
  if (final_block.length > 0) {
    plaintext_chunks.push(final_block);
    sha256.update(final_block);
  }

  return {
    content: Buffer.concat(plaintext_chunks),
    sha256_hex: sha256.digest('hex'),
  };
}

/** Checks whether a file should use stream-based restore. */
export function should_stream_restore(entry: SharePointManifestEntry): boolean {
  return entry.size_bytes > 4 * 1024 * 1024;
}

/** Verifies the computed SHA-256 against the manifest entry. */
export function verify_streaming_checksum(
  entry: SharePointManifestEntry,
  sha256_hex: string,
): boolean {
  if (!entry.checksum) {
    logger.warn(`Missing checksum for ${entry.file_name}; skipping restore`);
    return false;
  }
  if (sha256_hex !== entry.checksum) {
    logger.warn(`Checksum mismatch after streaming decrypt for ${entry.file_name}; skipping`);
    return false;
  }
  return true;
}

async function read_exact_bytes(readable: Readable, count: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let collected = 0;

  for await (const chunk of readable) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    chunks.push(buf);
    collected += buf.length;

    if (collected >= count) {
      const combined = Buffer.concat(chunks);
      const header = combined.subarray(0, count);
      const leftover = combined.subarray(count);
      if (leftover.length > 0) readable.unshift(leftover);
      return header;
    }
  }

  throw new Error(`Stream ended after ${collected} bytes; expected at least ${count}`);
}
