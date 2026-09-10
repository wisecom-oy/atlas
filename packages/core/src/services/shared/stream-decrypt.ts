import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { TenantContext } from '@wisecom/atlas-types';
import {
  has_content_header,
  read_content_header,
  CONTENT_HEADER_LENGTH,
  CONTENT_MAGIC,
} from '@/adapters/keystore/content-envelope';

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
 *
 * `label` names the object in the failure. The storage key is not used for that: it carries the
 * owner identifier, and this message reaches operator logs and run summaries.
 */
export async function* stream_verified_plaintext(
  ctx: TenantContext,
  storage_key: string,
  expected_sha256_hex: string,
  label: string,
): AsyncGenerator<Buffer> {
  const sha256 = createHash('sha256');
  for await (const chunk of decrypt_plaintext_chunks(ctx, storage_key)) {
    sha256.update(chunk);
    yield chunk;
  }
  const actual = sha256.digest('hex');
  // ponytail: seventh copy of this two-line comparison in the repo; one shared helper in
  // services/shared would be better, and touches five files this change has no business in.
  const matches =
    actual.length === expected_sha256_hex.length &&
    timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected_sha256_hex, 'utf8'));
  if (!matches) {
    throw new Error(
      `Checksum mismatch for ${label}: manifest recorded ${expected_sha256_hex}, decrypted ${actual}`,
    );
  }
}

/**
 * Yields decrypted plaintext chunks in one pass over the stored object.
 *
 * The IV and auth tag occupy the first {@link HEADER_LENGTH} bytes, preceded by the envelope
 * header on any object written since the scope binding existed (issue #350). Both may arrive split
 * across chunks, so they are assembled inside the single iteration over the stream. Reading them
 * in a separate `for await` loop and breaking out is what issue #143 was: an early exit from
 * `for await` calls the async iterator's `return()`, which destroys the stream, and every
 * subsequent read rejects with `AbortError: The operation was aborted`. One pass, no early exit,
 * no `unshift`. Consumers must drain this generator for the same reason.
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

  const prefix = new PrefixReader();
  let decipher: ReturnType<TenantContext['create_decipher']> | undefined;

  for await (const chunk of readable) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);

    if (decipher !== undefined) {
      const decrypted = decipher.update(buf);
      if (decrypted.length > 0) yield decrypted;
      continue;
    }

    const complete = prefix.push(buf);
    if (complete === undefined) continue;
    decipher = open_decipher(ctx, storage_key, complete, prefix.length);
    const decrypted = decipher.update(complete.subarray(prefix.length));
    if (decrypted.length > 0) yield decrypted;
  }

  if (decipher === undefined) {
    throw new Error(
      `Stream for ${storage_key} ended after ${prefix.collected} bytes; expected at least ` +
        `${prefix.length}`,
    );
  }

  const final_block = decipher.final();
  if (final_block.length > 0) yield final_block;
}

/**
 * Starts the decipher from the object's prefix: its envelope header when it has one, then the IV
 * and auth tag.
 */
function open_decipher(
  ctx: TenantContext,
  storage_key: string,
  prefix: Buffer,
  prefix_length: number,
): ReturnType<TenantContext['create_decipher']> {
  const envelope = prefix_length === HEADER_LENGTH ? undefined : read_content_header(prefix);
  const body = envelope === undefined ? prefix : prefix.subarray(CONTENT_HEADER_LENGTH);
  return ctx.create_decipher(
    body.subarray(0, IV_LENGTH),
    body.subarray(IV_LENGTH, HEADER_LENGTH),
    storage_key,
    envelope,
  );
}

/**
 * Collects the bytes ahead of the ciphertext across however many chunks they arrive in.
 *
 * How many there are is only known once the magic has arrived: an object written since the scope
 * binding carries a header before its IV, one written before it does not (issue #350).
 */
class PrefixReader {
  private readonly _chunks: Buffer[] = [];
  private _collected = 0;
  private _length = CONTENT_HEADER_LENGTH + HEADER_LENGTH;

  /** Bytes seen so far. */
  get collected(): number {
    return this._collected;
  }

  /** Bytes the prefix occupies, once the magic has settled it. */
  get length(): number {
    return this._length;
  }

  /** Adds a chunk, returning everything read so far once the whole prefix has arrived. */
  push(chunk: Buffer): Buffer | undefined {
    this._chunks.push(chunk);
    this._collected += chunk.length;
    const combined = Buffer.concat(this._chunks);
    if (this._collected >= CONTENT_MAGIC.length) {
      this._length = has_content_header(combined)
        ? CONTENT_HEADER_LENGTH + HEADER_LENGTH
        : HEADER_LENGTH;
    }
    return this._collected >= this._length ? combined : undefined;
  }
}
