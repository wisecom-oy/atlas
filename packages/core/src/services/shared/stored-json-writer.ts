import type { TenantContext } from '@wisecom/atlas-types';
import { RefusedWriteError } from '@wisecom/atlas-types';
import {
  confirm_stored_object,
  put_stored_object,
  type StoredObjectPut,
} from '@/services/shared/stored-object-put';

/**
 * The shape and identity check the reader of an object applies to its parsed body. Throws when
 * the reader would reject the body; the return value is ignored.
 */
export type StoredJsonReaderCheck = (parsed: unknown, key: string) => unknown;

/** For an object whose reader applies no check to the parsed body. */
export const READER_CHECKS_NOTHING: StoredJsonReaderCheck = () => undefined;

/** How one encrypted JSON metadata object is written. */
export interface StoredJsonWrite extends StoredObjectPut {
  /** The check this object's reader runs, so nothing is stored that it would call damaged. */
  readonly reader_check: StoredJsonReaderCheck;
  /** Reads the object back after the PUT and compares it with what was sent: one extra GET. */
  readonly confirm_read_back: boolean;
}

/**
 * Writes one encrypted JSON metadata object: serialise, check the result the way its reader will,
 * encrypt and decrypt back, upload, and read back when asked. Every step before the upload raises
 * `RefusedWriteError` and stores nothing.
 */
export async function write_encrypted_json(
  ctx: TenantContext,
  write: StoredJsonWrite,
  value: unknown,
): Promise<void> {
  await write_encrypted_json_text(ctx, write, serialise_json_document(write, value));
}

/**
 * Same as {@link write_encrypted_json} for a document the caller serialised itself, because its
 * key is derived from the exact bytes.
 */
export async function write_encrypted_json_text(
  ctx: TenantContext,
  write: StoredJsonWrite,
  json_text: string,
): Promise<void> {
  require_reader_accepts(write, json_text);
  const ciphertext = encrypt_and_decrypt_back(ctx, write, Buffer.from(json_text, 'utf-8'));
  await put_stored_object(ctx, write, ciphertext);
  if (write.confirm_read_back) await confirm_stored_object(ctx, write, ciphertext);
}

/**
 * Serialises the value as one JSON document. V8 raises `RangeError: Invalid string length` past
 * its string limit (about 512 MB), which is the only size ceiling there is.
 */
function serialise_json_document(write: StoredJsonWrite, value: unknown): string {
  let json_text: string | undefined;
  try {
    json_text = JSON.stringify(value);
  } catch (err) {
    const reason =
      err instanceof RangeError
        ? 'it is too large to store as one JSON document'
        : `it cannot be serialised as JSON (${error_text(err)})`;
    throw new RefusedWriteError(write.key, write.label, reason, { cause: err });
  }
  if (json_text === undefined) {
    throw new RefusedWriteError(write.key, write.label, 'it has no JSON form');
  }
  return json_text;
}

/**
 * Parses the serialised text and runs the reader's check on it, so the check sees what a reader
 * will: dates as strings, `undefined` fields gone, `NaN` as `null`.
 */
function require_reader_accepts(write: StoredJsonWrite, json_text: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json_text) as unknown;
  } catch (err) {
    throw new RefusedWriteError(write.key, write.label, 'it does not parse as JSON', {
      cause: err,
    });
  }
  try {
    write.reader_check(parsed, write.key);
  } catch (err) {
    throw new RefusedWriteError(
      write.key,
      write.label,
      `its reader would reject it (${error_text(err)})`,
      { cause: err },
    );
  }
}

/** Encrypts the plaintext and requires the ciphertext to decrypt back to the same bytes. */
function encrypt_and_decrypt_back(
  ctx: TenantContext,
  write: StoredJsonWrite,
  plaintext: Buffer,
): Buffer {
  const ciphertext = ctx.encrypt(plaintext, write.key);
  let decrypted: Buffer;
  try {
    decrypted = ctx.decrypt(ciphertext, write.key);
  } catch (err) {
    throw new RefusedWriteError(write.key, write.label, 'its ciphertext does not decrypt', {
      cause: err,
    });
  }
  if (!decrypted.equals(plaintext)) {
    throw new RefusedWriteError(
      write.key,
      write.label,
      'its ciphertext decrypts to different bytes than were encrypted',
    );
  }
  return ciphertext;
}

function error_text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
