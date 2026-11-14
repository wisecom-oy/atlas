import type { DeletionResult, HeldOwnerLease } from '@wisecom/atlas-types';
import { erase_lease_if_held } from '@/services/deletion/shared/leased-owner-deletion';
import {
  delete_scopes,
  has_survivors,
  merge_deletion_results,
  type DeletionStorage,
} from '@/services/deletion/shared/prefix-deleter';
import { logger } from '@/utils/logger';

/**
 * The wrapped DEK, deleted last so a blocked purge stays recoverable.
 *
 * Held back as this exact key, not as the whole `_meta/` prefix: replica markers
 * and replication status records share that tree and are themselves encrypted
 * with the DEK, so they have to go before the key that reads them.
 */
export const DEK_KEY = '_meta/dek.enc';

/**
 * Erases the whole tenant bucket while the tenant lease is held, in this order: every object except
 * the DEK and the lease, then the DEK if nothing survived, then the lease's own versions. The lease
 * is skipped by the sweep and goes last, so it blocks owners for the whole erasure and an erased
 * bucket keeps no lease object. The lease check runs before each pass that removes data.
 *
 * @returns the summary of the data and DEK passes. The lease is not counted: it is not backup data.
 */
export async function sweep_tenant_bucket(
  storage: DeletionStorage,
  lease: HeldOwnerLease,
): Promise<DeletionResult> {
  lease.assert_held();
  const data = await delete_scopes(storage, [''], [DEK_KEY, lease.storage_key]);
  const result = has_survivors(data)
    ? keep_dek_after_survivors(data)
    : await delete_dek_after_clean_sweep(storage, lease, data);
  await erase_lease_if_held(storage, lease);
  return result;
}

/** Holds the DEK back while objects survive: they stay recoverable only with it. */
function keep_dek_after_survivors(data: DeletionResult): DeletionResult {
  logger.error('Tenant purge left objects behind; keeping the DEK so they stay recoverable.');
  return data;
}

async function delete_dek_after_clean_sweep(
  storage: DeletionStorage,
  lease: HeldOwnerLease,
  data: DeletionResult,
): Promise<DeletionResult> {
  lease.assert_held();
  return merge_deletion_results(data, await delete_scopes(storage, [DEK_KEY]));
}
