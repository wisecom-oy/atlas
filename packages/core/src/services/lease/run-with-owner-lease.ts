import type {
  HeldOwnerLease,
  OwnerLeasePort,
  OwnerLeaseRequest,
  TenantStorageContext,
} from '@wisecom/atlas-types';
import { refuse_live_owner_lease } from '@/services/lease/owner-lease-reader';
import { is_storage_access_denied } from '@/services/shared/storage-access-denied';
import { logger } from '@/utils/logger';

/**
 * Runs one operation while holding its owner's lease, and releases the lease however the run ends:
 * a result, an error, or a cancellation. Nothing in `run` executes unless the lease was taken.
 *
 * `ctx` is the tenant's storage as the factory built it, without run retention. A storage-only
 * context is enough: the lease is not encrypted.
 */
export async function run_with_owner_lease<T>(
  leases: OwnerLeasePort,
  ctx: TenantStorageContext,
  request: OwnerLeaseRequest,
  run: (lease: HeldOwnerLease) => Promise<T>,
): Promise<T> {
  const lease = await leases.acquire(ctx, request);
  try {
    return await run(lease);
  } finally {
    await lease.release();
  }
}

/**
 * As {@link run_with_owner_lease}, for an operation that only reads the bucket: a restore. When
 * the storage credentials may not write the lease (HTTP 403), the run goes ahead without one and
 * warns that concurrent-run protection is off, because restores have always worked with read-only
 * credentials. A live lease another run holds still refuses it: reading the lease needs no write
 * access.
 *
 * `run` receives `ctx` back, so a caller keeps one name for the context it reads through.
 *
 * @throws OwnerBusyError when another operation holds a live lease on the owner.
 */
export async function run_with_owner_lease_when_writable<C extends TenantStorageContext, T>(
  leases: OwnerLeasePort,
  ctx: C,
  request: OwnerLeaseRequest,
  run: (ctx: C) => Promise<T>,
): Promise<T> {
  let lease: HeldOwnerLease;
  try {
    lease = await leases.acquire(ctx, request);
  } catch (err) {
    if (!is_storage_access_denied(err)) throw err;
    await refuse_live_owner_lease(ctx, request);
    logger.warn(
      `Storage credentials cannot write the run lease for ${request.workload} owner ` +
        `${request.owner_id}: concurrent-run protection is off for this ${request.operation}. ` +
        'Another run on this owner is not detected.',
    );
    return run(ctx);
  }
  try {
    return await run(ctx);
  } finally {
    await lease.release();
  }
}
