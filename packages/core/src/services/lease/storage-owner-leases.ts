import type {
  HeldOwnerLease,
  OwnerLeasePort,
  OwnerLeaseRequest,
  TenantStorageContext,
} from '@wisecom/atlas-types';
import { acquire_owner_lease } from '@/services/lease/owner-lease-acquirer';
import { owner_lease_key } from '@/services/lease/owner-lease-key';
import {
  SYSTEM_OWNER_LEASE_RUNTIME,
  type OwnerLeaseRuntime,
} from '@/services/lease/owner-lease-timing';
import { RenewingOwnerLease } from '@/services/lease/renewing-owner-lease';
import { ObjectLockingStorage } from '@/services/shared/run-object-lock';

/**
 * Owner leases kept as one plaintext JSON object per workload and owner in the tenant bucket
 * (issue #623). They need storage only, never the tenant key. Exclusion rests on the backend honouring `If-None-Match` and `If-Match`, which
 * `atlas storage-check` probes.
 */
export class StorageOwnerLeases implements OwnerLeasePort {
  constructor(private readonly _runtime: OwnerLeaseRuntime = SYSTEM_OWNER_LEASE_RUNTIME) {}

  /** Takes the owner's lease and starts renewing it. */
  async acquire(ctx: TenantStorageContext, request: OwnerLeaseRequest): Promise<HeldOwnerLease> {
    require_storage_without_run_retention(ctx);
    const key = owner_lease_key(request.workload, request.owner_id);
    const acquired = await acquire_owner_lease(ctx, request, key, this._runtime);
    return new RenewingOwnerLease(ctx, request, acquired, this._runtime);
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
