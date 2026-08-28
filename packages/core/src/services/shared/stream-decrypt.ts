import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { TenantContext } from '@wisecom/atlas-types';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const HEADER_LENGTH = IV_LENGTH + AUTH_TAG_LENGTH;

export interface StreamDecryptResult {
  readonly content: Buffer;
  readonly sha256_hex: string;
}

/**
 * Reads an encrypted object from storage as a stream, decrypts it with
 * AES-256-GCM, and computes the plaintext SHA-256 incrementally.
 *
 * Retains the whole plaintext, so callers that only need the digest should use
 * {@link stream_sha256_from_storage} instead.
 */
export async function stream_decrypt_from_storage(
  ctx: TenantContext,
  storage_key: string,
): Promise<StreamDecryptResult> {
  const sha256 = createHash('sha256');
  const plaintext_chunks: Buffer[] = [];

  for await (const chunk of decrypt_plaintext_chunks(ctx, storage_key)) {
    plaintext_chunks.push(chunk);
    sha256.update(chunk);
  }

  return { content: Buffer.concat(plaintext_chunks), sha256_hex: sha256.digest('hex') };
}

/**
 * Computes the plaintext SHA-256 of an encrypted object without ever holding
 * it whole.
 *
 * Integrity checks compare digests, not bytes, so buffering the object and its
 * decrypted copy only bounded verification by object size.
 */
export async function stream_sha256_from_storage(
  ctx: TenantContext,
  storage_key: string,
): Promise<string> {
  const sha256 = createHash('sha256');
  for await (const chunk of decrypt_plaintext_chunks(ctx, storage_key)) {
    sha256.update(chunk);
  }
  return sha256.digest('hex');
}

/**
 * Yields decrypted plaintext chunks in one pass over the stored object.
 *
 * The IV and auth tag occupy the first {@link HEADER_LENGTH} bytes, which may
 * arrive split across chunks, so the header is assembled inside the single
 * iteration over the stream. Reading it in a separate `for await` loop and
 * breaking out is what issue #143 was: an early exit from `for await` calls the
 * async iterator's `return()`, which destroys the stream, and every subsequent
 * read rejects with `AbortError: The operation was aborted`. One pass, no early
 * exit, no `unshift`. Consumers must drain this generator for the same reason.
 */
async function* decrypt_plaintext_chunks(
  ctx: TenantContext,
  storage_key: string,
): AsyncGenerator<Buffer> {
  const raw_stream = await ctx.storage.get_stream(storage_key);
  const readable =
    raw_stream instanceof Readable
      ? raw_stream
      : Readable.from(raw_stream as AsyncIterable<Buffer>);

  const header_chunks: Buffer[] = [];
  let header_length = 0;
  let decipher: ReturnType<TenantContext['create_decipher']> | undefined;

  for await (const chunk of readable) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);

    if (decipher !== undefined) {
      const decrypted = decipher.update(buf);
      if (decrypted.length > 0) yield decrypted;
      continue;
    }

    header_chunks.push(buf);
    header_length += buf.length;
    if (header_length < HEADER_LENGTH) continue;

    const combined = Buffer.concat(header_chunks);
    decipher = ctx.create_decipher(
      combined.subarray(0, IV_LENGTH),
      combined.subarray(IV_LENGTH, HEADER_LENGTH),
    );
    const decrypted = decipher.update(combined.subarray(HEADER_LENGTH));
    if (decrypted.length > 0) yield decrypted;
  }

  if (decipher === undefined) {
    throw new Error(
      `Stream for ${storage_key} ended after ${header_length} bytes; expected at least ${HEADER_LENGTH}`,
    );
  }

  const final_block = decipher.final();
  if (final_block.length > 0) yield final_block;
}
