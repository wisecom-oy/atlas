import type { TenantContext } from '@wisecom/atlas-types';
import { StorageError, UnreadableObjectsError } from '@wisecom/atlas-types';
import { is_absent_object_error } from '@/services/shared/absent-object';

/**
 * Reads and decrypts one stored JSON object without a HEAD probe first.
 *
 * Absence returns `undefined`. A failed fetch raises `StorageError`, because it says nothing about
 * the object and a retry may succeed. Ciphertext that fails to decrypt, or plaintext that is not
 * JSON, raises `UnreadableContentError`: the object is damaged and a retry gives the same answer,
 * which is the distinction a listing needs to skip it rather than fail (issue #631).
 */
export async function read_encrypted_json(
  ctx: TenantContext,
  key: string,
  label: string,
): Promise<unknown> {
  let payload: Buffer;
  try {
    payload = await ctx.storage.get(key);
  } catch (err) {
    if (is_absent_object_error(err)) return undefined;
    throw new StorageError(`Could not read the ${label} at ${key}`, { cause: err });
  }
  try {
    return JSON.parse(ctx.decrypt(payload, key).toString('utf-8')) as unknown;
  } catch (err) {
    throw new UnreadableObjectsError(`The ${label} does not decrypt or parse`, [key], {
      cause: err,
    });
  }
}

/** Whether a parsed JSON value is a plain object, the only shape a stored record can have. */
export function is_json_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
