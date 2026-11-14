import type { OwnerLeaseRequest, TenantStorageContext } from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import { TENANT_LEASE_KEY } from '@/services/lease/owner-lease-key';
import { find_live_owner_lease } from '@/services/lease/owner-lease-scan';
import { read_live_owner_lease } from '@/services/lease/owner-lease-record';

/**
 * The check an owner operation makes after it has written its own lease: refuses while a purge or
 * key re-wrap holds the tenant lease. Reads one object, and only one.
 *
 * @throws OwnerBusyError when the tenant lease is live, naming the owner that was refused.
 */
export async function refuse_while_tenant_leased(
  ctx: TenantStorageContext,
  request: OwnerLeaseRequest,
  now_ms: number,
): Promise<void> {
  const holder = await read_live_owner_lease(ctx, TENANT_LEASE_KEY, now_ms);
  if (holder === undefined) return;
  throw new OwnerBusyError({
    workload: request.workload,
    owner_id: request.owner_id,
    held_by_operation: holder.operation,
    lease_expires_at: holder.expires_at,
  });
}

/**
 * The check a tenant operation makes after it has written the tenant lease: refuses while any
 * owner lease in the tenant is live. The error names the first live owner it finds.
 *
 * @throws OwnerBusyError when an owner lease is live.
 */
export async function refuse_while_owners_leased(
  ctx: TenantStorageContext,
  now_ms: number,
): Promise<void> {
  const owner = await find_live_owner_lease(ctx, now_ms);
  if (owner === undefined) return;
  throw new OwnerBusyError({
    workload: owner.workload,
    owner_id: owner.owner_id,
    held_by_operation: owner.record.operation,
    lease_expires_at: owner.record.expires_at,
  });
}

/**
 * Runs the cross-check that matches a lease a run just wrote: an owner checks the tenant lease,
 * and the tenant lease checks every owner lease. Either order of writes is caught this way: each
 * side reads the other's object after writing its own.
 *
 * @throws OwnerBusyError when the opposite side holds a live lease.
 */
export async function refuse_while_conflicting_lease_live(
  ctx: TenantStorageContext,
  request: OwnerLeaseRequest,
  now_ms: number,
): Promise<void> {
  if (request.workload === 'tenant') return refuse_while_owners_leased(ctx, now_ms);
  return refuse_while_tenant_leased(ctx, request, now_ms);
}
