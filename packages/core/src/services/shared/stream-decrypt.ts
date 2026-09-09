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
 * Yields the plaintext of an encrypted object and fails the iteration unless the digest matches
 * `expected_sha256_hex`.
 *
 * Nothing about a chunk is trustworthy while it is being yielded: AES-GCM only authenticates at
 * `final()`, and the manifest checksum is only comparable once every byte has passed through. A
 * consumer therefore MUST NOT make the bytes visible to anyone until the iteration has completed
 * normally. A Graph upload session satisfies that by holding its last chunk back, so the item is
 * only created after this generator returns; a caller that cannot delay its side effect that way
 * wants {@link stream_decrypt_from_storage} and its buffered verification instead (issue #343).
 *
 * The generator must be drained or its `return()` called, which a `for await` loop does either way.
 */
export async function* stream_verified_plaintext(
  ctx: TenantContext,
  storage_key: string,
  expected_sha256_hex: string,
): AsyncGenerator<Buffer> {
  const sha256 = createHash('sha256');
  for await (const chunk of decrypt_plaintext_chunks(ctx, storage_key)) {
    sha256.update(chunk);
    yield chunk;
  }
  const actual = sha256.digest('hex');
  if (actual !== expected_sha256_hex) {
    throw new Error(
      `Checksum mismatch for ${storage_key}: manifest recorded ${expected_sha256_hex}, decrypted ${actual}`,
    );
  }
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
