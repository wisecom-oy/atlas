import type {
  HeldOwnerLease,
  OwnerLeasePort,
  OwnerLeaseRequest,
  TenantStorageContext,
} from '@wisecom/atlas-types';
import { acquire_owner_lease } from '@/services/lease/owner-lease-acquirer';
import { owner_lease_key } from '@/services/lease/owner-lease-key';
import { refuse_while_conflicting_lease_live } from '@/services/lease/lease-conflict-check';
import {
  SYSTEM_OWNER_LEASE_RUNTIME,
  type OwnerLeaseRuntime,
} from '@/services/lease/owner-lease-timing';
import { RenewingOwnerLease } from '@/services/lease/renewing-owner-lease';
import { ObjectLockingStorage } from '@/services/shared/run-object-lock';

/**
 * Owner leases kept as one plaintext JSON object per workload and owner in the tenant bucket
 * (issue #623), and the tenant lease a purge or key re-wrap takes (issue #739). They need storage
 * only, never the tenant key. Exclusion rests on the backend honouring `If-None-Match` and
 * `If-Match`, which `atlas storage-check` probes.
 */
export class StorageOwnerLeases implements OwnerLeasePort {
  constructor(private readonly _runtime: OwnerLeaseRuntime = SYSTEM_OWNER_LEASE_RUNTIME) {}

  /**
   * Takes the lease, then checks the opposite side's lease. A run that finds a live conflict
   * releases its own lease before it throws, so a refused run leaves nothing behind.
   */
  async acquire(ctx: TenantStorageContext, request: OwnerLeaseRequest): Promise<HeldOwnerLease> {
    require_storage_without_run_retention(ctx);
    const key = owner_lease_key(request.workload, request.owner_id);
    const acquired = await acquire_owner_lease(ctx, request, key, this._runtime);
    const lease = new RenewingOwnerLease(ctx, request, acquired, this._runtime);
    try {
      await refuse_while_conflicting_lease_live(ctx, request, this._runtime.now());
    } catch (err) {
      await lease.release();
      throw err;
    }
    return lease;
  }
}

/**
 * Refuses a context decorated with a run's Object Lock retention. That decorator attaches the
 * run's policy to every put without one, and a retained lease version could not be removed.
 */
function require_storage_without_run_retention(ctx: TenantStorageContext): void {
  if (ctx.storage instanceof ObjectLockingStorage) {
    throw new Error(
      'An owner lease must be written through the tenant context without run retention',
    );
  }
}
