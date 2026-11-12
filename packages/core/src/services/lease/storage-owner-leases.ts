import { injectable } from 'inversify';
import {
  OwnerLeaseLostError,
  type LeaseableContext,
  type OwnerLeases,
  type OwnerLeaseScope,
  type TenantLeaseOperation,
} from '@wisecom/atlas-types';
import type { HeldLease } from '@/services/lease/held-lease';
import {
  acquire_lease,
  refuse_during_owner_leases,
  refuse_during_tenant_lease,
} from '@/services/lease/lease-acquisition';
import { LeaseGuardedStorage } from '@/services/lease/lease-guarded-storage';
import { owner_lease_key, TENANT_LEASE_KEY } from '@/services/lease/lease-record';
import { is_storage_access_denied } from '@/services/shared/storage-access-denied';
import { logger } from '@/utils/logger';

/**
 * Holds per-owner and tenant leases as objects in the tenant bucket (`_meta/leases/`).
 *
 * Costs a handful of S3 requests per run and one renewal every two minutes, never one per object,
 * and no Graph request at all.
 */
@injectable()
export class StorageOwnerLeases implements OwnerLeases {
  /** Runs `run` holding the owner's lease. */
  async run_exclusive<C extends LeaseableContext, T>(
    ctx: C,
    scope: OwnerLeaseScope,
    run: (leased: C) => Promise<T>,
  ): Promise<T> {
    const lease = await acquire_owner_lease(ctx, scope);
    return run_holding(ctx, lease, run);
  }

  /** Runs `run` holding the owner's lease, or unleased when storage credentials cannot write. */
  async run_exclusive_when_writable<C extends LeaseableContext, T>(
    ctx: C,
    scope: OwnerLeaseScope,
    run: (leased: C) => Promise<T>,
  ): Promise<T> {
    let lease: HeldLease;
    try {
      lease = await acquire_owner_lease(ctx, scope);
    } catch (err) {
      if (!is_storage_access_denied(err)) throw err;
      logger.warn(
        `Storage credentials cannot write the run lease for ${scope.owner_id}; running the ` +
          `${scope.operation} unleased, so a concurrent run on this owner is not detected.`,
      );
      return run(ctx);
    }
    return run_holding(ctx, lease, run);
  }

  /** Runs `run` holding the tenant lease, once no owner lease is live. */
  async run_tenant_exclusive<C extends LeaseableContext, T>(
    ctx: C,
    operation: TenantLeaseOperation,
    run: (leased: C) => Promise<T>,
  ): Promise<T> {
    const lease = await acquire_lease(ctx.storage, TENANT_LEASE_KEY, operation);
    await release_on_failure(lease, () => refuse_during_owner_leases(ctx.storage));
    return run_holding(ctx, lease, run);
  }
}

/**
 * Takes the owner's lease, then checks the tenant lease. Tenant runs do the mirror image (take
 * theirs, then check owners), so whichever of two racing runs writes second sees the other.
 */
async function acquire_owner_lease(
  ctx: LeaseableContext,
  scope: OwnerLeaseScope,
): Promise<HeldLease> {
  const key = owner_lease_key(scope.workload, scope.owner_id);
  const lease = await acquire_lease(ctx.storage, key, scope.operation);
  await release_on_failure(lease, () => refuse_during_tenant_lease(ctx.storage));
  return lease;
}

async function release_on_failure(lease: HeldLease, check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    await lease.release();
    throw err;
  }
}

/**
 * Runs `run` with storage that refuses writes once the lease is lost, renewing meanwhile, and
 * releases the lease however `run` ends. A run that lost its lease rejects even when `run`
 * resolved: its result was produced without the exclusion it relies on, and some of its writes
 * were refused.
 */
async function run_holding<C extends LeaseableContext, T>(
  ctx: C,
  lease: HeldLease,
  run: (leased: C) => Promise<T>,
): Promise<T> {
  lease.start_renewal();
  try {
    const result = await run({ ...ctx, storage: new LeaseGuardedStorage(ctx.storage, lease) });
    const lost_reason = lease.lost_reason();
    if (lost_reason !== undefined) throw new OwnerLeaseLostError(lease.key, lost_reason);
    return result;
  } finally {
    await lease.release();
  }
}
