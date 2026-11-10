import type { ObjectStorage } from '@wisecom/atlas-types';
import { StorageError } from '@wisecom/atlas-types';
import { is_precondition_failure } from '@/services/shared/precondition-failure';

export const DEK_META_KEY = '_meta/dek.enc';

/**
 * Thrown when another writer put a different data key at the destination while this run was
 * copying the source key, so the conditional write was refused and nothing was overwritten.
 */
export class DekWriteConflictError extends StorageError {
  constructor(tenant_id: string, cause: unknown) {
    super(
      `Refusing to install the source encryption key for tenant ${tenant_id}: ${DEK_META_KEY} ` +
        `on the destination changed while this run was writing it, and it now holds a different ` +
        `key. The stored key was left untouched. A backup, rehydrate, or replicate is likely ` +
        `running against the same bucket. Stop every other run against this tenant, then rerun. ` +
        `If the destination already holds data under the other key and that data is disposable, ` +
        `purge the tenant (atlas delete --purge) first.`,
      { cause },
    );
  }
}

/**
 * Writes the source DEK blob only when the destination has none (If-None-Match: *).
 *
 * Losing the race to a concurrent writer is fine when it stored the same blob; any other key is a
 * conflict, because data may already be encrypted under it.
 */
export async function create_dek_if_absent(
  storage: ObjectStorage,
  dek_blob: Buffer,
  tenant_id: string,
): Promise<void> {
  try {
    await storage.put(DEK_META_KEY, dek_blob, undefined, undefined, undefined, true);
  } catch (err) {
    await settle_refused_dek_write(storage, dek_blob, tenant_id, err);
  }
}

/**
 * Replaces the destination DEK blob only while it still carries `expected_etag` (If-Match).
 *
 * The ETag is the one read before the caller decided replacing was safe, so a key that changed
 * after that decision is never overwritten.
 */
export async function replace_dek_if_unchanged(
  storage: ObjectStorage,
  dek_blob: Buffer,
  expected_etag: string,
  tenant_id: string,
): Promise<void> {
  try {
    await storage.put(DEK_META_KEY, dek_blob, undefined, undefined, expected_etag);
  } catch (err) {
    await settle_refused_dek_write(storage, dek_blob, tenant_id, err);
  }
}

/**
 * Accepts a refused write when the stored blob is already the intended one, otherwise raises.
 *
 * Errors that are not a 412 are rethrown unchanged.
 */
async function settle_refused_dek_write(
  storage: ObjectStorage,
  dek_blob: Buffer,
  tenant_id: string,
  err: unknown,
): Promise<void> {
  if (!is_precondition_failure(err)) throw err;
  const stored = await storage.get(DEK_META_KEY);
  if (!stored.equals(dek_blob)) throw new DekWriteConflictError(tenant_id, err);
}
