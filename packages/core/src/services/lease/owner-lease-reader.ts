import type { OwnerLeaseRequest, TenantStorageContext } from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import { owner_lease_key } from '@/services/lease/owner-lease-key';
import { read_owner_lease } from '@/services/lease/owner-lease-record';

/**
 * Refuses when another operation holds a live lease on the owner, by reading it only. For a run
 * whose credentials cannot write a lease of its own: it can still see one that is held.
 *
 * @throws OwnerBusyError when the stored lease is live and not released.
 */
export async function refuse_live_owner_lease(
  ctx: TenantStorageContext,
  request: OwnerLeaseRequest,
): Promise<void> {
  const stored = await read_owner_lease(ctx, owner_lease_key(request.workload, request.owner_id));
  const record = stored?.record;
  if (record === undefined || record.released_at !== undefined) return;
  if (Date.parse(record.expires_at) <= Date.now()) return;
  throw new OwnerBusyError({
    workload: request.workload,
    owner_id: request.owner_id,
    held_by_operation: record.operation,
    lease_expires_at: record.expires_at,
  });
}
