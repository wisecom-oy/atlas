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
 * The IV and auth tag occupy the first {@link HEADER_LENGTH} bytes, which may
 * arrive split across chunks, so the header is assembled inside the single
 * iteration over the stream. Reading it in a separate `for await` loop and
 * breaking out is what issue #143 was: an early exit from `for await` calls the
 * async iterator's `return()`, which destroys the stream, and every subsequent
 * read rejects with `AbortError: The operation was aborted`. One pass, no early
 * exit, no `unshift`.
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

  const header_chunks: Buffer[] = [];
  let header_length = 0;
  let decipher: ReturnType<TenantContext['create_decipher']> | undefined;
  const sha256 = createHash('sha256');
  const plaintext_chunks: Buffer[] = [];

  const consume = (payload: Buffer): void => {
    if (payload.length === 0) return;
    const decrypted = decipher!.update(payload);
    if (decrypted.length > 0) {
      plaintext_chunks.push(decrypted);
      sha256.update(decrypted);
    }
  };

  for await (const chunk of readable) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);

    if (decipher !== undefined) {
      consume(buf);
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
    consume(combined.subarray(HEADER_LENGTH));
  }

  if (decipher === undefined) {
    throw new Error(
      `Stream for ${storage_key} ended after ${header_length} bytes; expected at least ${HEADER_LENGTH}`,
    );
  }

  const final_block = decipher.final();
  if (final_block.length > 0) {
    plaintext_chunks.push(final_block);
    sha256.update(final_block);
  }

  return { content: Buffer.concat(plaintext_chunks), sha256_hex: sha256.digest('hex') };
}
