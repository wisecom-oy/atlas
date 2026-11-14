import type { OwnerLeaseRequest, TenantStorageContext } from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import { refuse_while_tenant_leased } from '@/services/lease/lease-conflict-check';
import { owner_lease_key } from '@/services/lease/owner-lease-key';
import { read_live_owner_lease } from '@/services/lease/owner-lease-record';

/**
 * Refuses when another operation holds a live lease on the owner, or a purge or re-wrap holds the
 * tenant, by reading only. For a run whose credentials cannot write a lease of its own: it can
 * still see one that is held.
 *
 * @throws OwnerBusyError when a stored lease is live and not released.
 */
export async function refuse_live_owner_lease(
  ctx: TenantStorageContext,
  request: OwnerLeaseRequest,
): Promise<void> {
  const now_ms = Date.now();
  const record = await read_live_owner_lease(
    ctx,
    owner_lease_key(request.workload, request.owner_id),
    now_ms,
  );
  if (record !== undefined) {
    throw new OwnerBusyError({
      workload: request.workload,
      owner_id: request.owner_id,
      held_by_operation: record.operation,
      lease_expires_at: record.expires_at,
    });
  }
  await refuse_while_tenant_leased(ctx, request, now_ms);
}
