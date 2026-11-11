import type { TenantContext } from '@wisecom/atlas-types';
import { StorageError, UnreadableContentError } from '@wisecom/atlas-types';
import { is_absent_object_error } from '@/services/shared/absent-object';

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
 * real state (issue #438).
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
  if (value === undefined || body_names_key(value, key, key_of)) return value;
  throw new UnreadableContentError(
    `The state object at ${key} belongs to a different owner than its key names`,
  );
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

/** Decrypts and parses a state payload, raising `UnreadableContentError` when either step fails. */
function decrypt_state<T>(ctx: TenantContext, key: string, payload: Buffer): T {
  try {
    return JSON.parse(ctx.decrypt(payload, key).toString('utf-8')) as T;
  } catch (err) {
    throw new UnreadableContentError(`The state object at ${key} is corrupt or tampered`, {
      cause: err,
    });
  }
}
