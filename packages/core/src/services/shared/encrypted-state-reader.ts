import type { TenantContext } from '@wisecom/atlas-types';
import {
  StorageError,
  UnreadableContentError,
  UnsupportedFormatVersionError,
} from '@wisecom/atlas-types';
import { is_absent_object_error } from '@/services/shared/absent-object';
import type { StoredJsonReaderCheck } from '@/services/shared/stored-json-writer';

/** A decrypted state object and the ETag it was read at, for a compare-and-swap write. */
export interface EncryptedStateSnapshot<T> {
  readonly value: T;
  readonly etag: string;
}

/**
 * Reads one encrypted JSON state object; `undefined` only when the object is absent.
 *
 * A fetch failure raises `StorageError`, and a body that fails to decrypt or parse raises
 * `UnreadableContentError`. Reading either as "no state yet" lets the next save overwrite the
 * real state (issue #438). An object a newer Atlas wrote raises `UnsupportedFormatVersionError`.
 */
export async function load_encrypted_json<T>(
  ctx: TenantContext,
  key: string,
): Promise<T | undefined> {
  const payload = await fetch_state(ctx, key, async () => ctx.storage.get(key));
  return payload === undefined ? undefined : decrypt_state<T>(ctx, key, payload);
}

/**
 * Same contract as {@link load_encrypted_json}, and rejects a body that names a different key.
 *
 * The envelope binds ciphertext to its directory, not its file name, so one owner's state object
 * copied over another's in a shared directory still decrypts. `key_of` rebuilds the key from the
 * body's own owner fields; a body it does not reproduce `key` from raises `UnreadableContentError`
 * instead of resuming one owner's backup from another's state (issue #622).
 */
export async function load_encrypted_json_bound_to_key<T>(
  ctx: TenantContext,
  key: string,
  key_of: (value: T) => string,
): Promise<T | undefined> {
  const value = await load_encrypted_json<T>(ctx, key);
  if (value !== undefined) require_state_names_key(value, key, key_of);
  return value;
}

/** Raises `UnreadableContentError` unless `key_of` rebuilds `key` from the parsed state body. */
export function require_state_names_key<T>(
  value: T,
  key: string,
  key_of: (value: T) => string,
): void {
  if (body_names_key(value, key, key_of)) return;
  throw new UnreadableContentError(
    `The state object at ${key} belongs to a different owner than its key names`,
  );
}

/** The check {@link load_encrypted_json_bound_to_key} applies, for the writer of the same object. */
export function state_names_key_check<T>(key_of: (value: T) => string): StoredJsonReaderCheck {
  return (parsed, key) => require_state_names_key(parsed as T, key, key_of);
}

/** Whether `key_of` rebuilds `key` from the body; a body it cannot read names no key. */
function body_names_key<T>(value: T, key: string, key_of: (value: T) => string): boolean {
  try {
    return key_of(value) === key;
  } catch {
    return false;
  }
}

/** Same contract as {@link load_encrypted_json}, also returning the ETag the object was read at. */
export async function load_encrypted_json_with_etag<T>(
  ctx: TenantContext,
  key: string,
): Promise<EncryptedStateSnapshot<T> | undefined> {
  const read = await fetch_state(ctx, key, async () => ctx.storage.get_with_etag(key));
  return read === undefined
    ? undefined
    : { value: decrypt_state<T>(ctx, key, read.data), etag: read.etag };
}

/** Runs `read` when the key exists, mapping absence to `undefined` and any other failure to `StorageError`. */
async function fetch_state<R>(
  ctx: TenantContext,
  key: string,
  read: () => Promise<R>,
): Promise<R | undefined> {
  try {
    if (!(await ctx.storage.exists(key))) return undefined;
    return await read();
  } catch (err) {
    if (is_absent_object_error(err)) return undefined;
    throw new StorageError(`Could not read the state object at ${key}`, { cause: err });
  }
}

/**
 * Decrypts and parses a state payload, raising `UnreadableContentError` when either step fails.
 *
 * `UnsupportedFormatVersionError` passes through unchanged: the object is intact, and a caller
 * that starts over from an unreadable state object would overwrite what a newer Atlas wrote.
 */
function decrypt_state<T>(ctx: TenantContext, key: string, payload: Buffer): T {
  try {
    return JSON.parse(ctx.decrypt(payload, key).toString('utf-8')) as T;
  } catch (err) {
    if (err instanceof UnsupportedFormatVersionError) throw err;
    throw new UnreadableContentError(`The state object at ${key} is corrupt or tampered`, {
      cause: err,
    });
  }
}
