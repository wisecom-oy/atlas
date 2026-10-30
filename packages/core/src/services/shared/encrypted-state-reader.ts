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
  const payload = await fetch_state(key, async () => ctx.storage.get(key), ctx);
  return payload === undefined ? undefined : decrypt_state<T>(ctx, key, payload);
}

/** Same contract as {@link load_encrypted_json}, also returning the ETag the object was read at. */
export async function load_encrypted_json_with_etag<T>(
  ctx: TenantContext,
  key: string,
): Promise<EncryptedStateSnapshot<T> | undefined> {
  const read = await fetch_state(key, async () => ctx.storage.get_with_etag(key), ctx);
  return read === undefined
    ? undefined
    : { value: decrypt_state<T>(ctx, key, read.data), etag: read.etag };
}

/** Runs `read` when the key exists, mapping absence to `undefined` and any other failure to `StorageError`. */
async function fetch_state<R>(
  key: string,
  read: () => Promise<R>,
  ctx: TenantContext,
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
