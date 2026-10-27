import type { TenantContext } from '@wisecom/atlas-types';
import { StorageError, UnreadableContentError } from '@wisecom/atlas-types';
import { is_absent_object_error } from '@/services/shared/absent-object';

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
  let payload: Buffer;
  try {
    if (!(await ctx.storage.exists(key))) return undefined;
    payload = await ctx.storage.get(key);
  } catch (err) {
    if (is_absent_object_error(err)) return undefined;
    throw new StorageError(`Could not read the state object at ${key}`, { cause: err });
  }
  try {
    return JSON.parse(ctx.decrypt(payload, key).toString('utf-8')) as T;
  } catch (err) {
    throw new UnreadableContentError(`The state object at ${key} is corrupt or tampered`, {
      cause: err,
    });
  }
}
