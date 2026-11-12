import type {
  HeldOwnerLease,
  OwnerLeasePort,
  OwnerLeaseRequest,
  TenantStorageContext,
} from '@wisecom/atlas-types';

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
