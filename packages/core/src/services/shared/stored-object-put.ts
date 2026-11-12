import type { StorageObjectLockPolicy, TenantContext } from '@wisecom/atlas-types';
import { StorageError, StoredObjectConflictError } from '@wisecom/atlas-types';
import { is_precondition_failure } from '@/services/shared/precondition-failure';

/** Where one ciphertext goes and under which condition. */
export interface StoredObjectPut {
  readonly key: string;
  /** Operator-facing name of the object, e.g. `Outlook manifest`. */
  readonly label: string;
  /** `create_only` never replaces an existing object; `overwrite` is an unconditional PUT. */
  readonly write: 'create_only' | 'overwrite';
  readonly object_lock_policy?: StorageObjectLockPolicy | undefined;
}

/** Uploads the ciphertext under the condition the put names. */
export async function put_stored_object(
  ctx: TenantContext,
  put: StoredObjectPut,
  ciphertext: Buffer,
): Promise<void> {
  if (put.write === 'create_only') {
    await put_create_only(ctx, put, ciphertext);
  } else if (put.object_lock_policy !== undefined) {
    await ctx.storage.put(put.key, ciphertext, undefined, put.object_lock_policy);
  } else {
    await ctx.storage.put(put.key, ciphertext);
  }
}

/**
 * Uploads with `If-None-Match: *`. A refused write is not yet a conflict: the storage client
 * retries a PUT whose response was lost, and the retry meets the object its first attempt created.
 * The stored bytes tell the two apart.
 */
async function put_create_only(
  ctx: TenantContext,
  put: StoredObjectPut,
  ciphertext: Buffer,
): Promise<void> {
  try {
    await ctx.storage.put(put.key, ciphertext, undefined, put.object_lock_policy, undefined, true);
  } catch (err) {
    if (!is_precondition_failure(err)) throw err;
    await require_existing_object_is_this_write(ctx, put, ciphertext, err);
  }
}

/** Raises unless the object already under the key is byte for byte the ciphertext just sent. */
async function require_existing_object_is_this_write(
  ctx: TenantContext,
  put: StoredObjectPut,
  ciphertext: Buffer,
  refusal: unknown,
): Promise<void> {
  let stored: Buffer;
  try {
    stored = await ctx.storage.get(put.key);
  } catch (err) {
    throw new StorageError(
      `The create-only write of the ${put.label} at ${put.key} was refused, and the object ` +
        'already there could not be read to tell whether an earlier attempt of this write stored it',
      { cause: err },
    );
  }
  if (!stored.equals(ciphertext)) {
    throw new StoredObjectConflictError(put.key, put.label, { cause: refusal });
  }
}

/** Reads the object back and raises `StorageError` unless it is the ciphertext that was sent. */
export async function confirm_stored_object(
  ctx: TenantContext,
  put: StoredObjectPut,
  ciphertext: Buffer,
): Promise<void> {
  let stored: Buffer;
  try {
    stored = await ctx.storage.get(put.key);
  } catch (err) {
    throw new StorageError(
      `The ${put.label} at ${put.key} was written but could not be read back to confirm it`,
      { cause: err },
    );
  }
  if (!stored.equals(ciphertext)) {
    throw new StorageError(
      `The ${put.label} at ${put.key} was written, but reading it back returned different ` +
        'bytes than were sent',
    );
  }
}
