import type {
  DeletionResult,
  HeldOwnerLease,
  ObjectStorage,
  OwnerLeasePort,
  OwnerLeaseWorkload,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { delete_scopes, type DeletionStorage } from '@/services/deletion/shared/prefix-deleter';
import { run_with_owner_lease } from '@/services/lease/run-with-owner-lease';
import { logger } from '@/utils/logger';

/** What a deletion service needs to open a tenant and take an owner's lease. */
export interface LeasedDeletionPorts {
  readonly tenant_factory: TenantContextFactory;
  readonly leases: OwnerLeasePort;
}

/** The owner a deletion acts on. */
export interface DeletionOwner {
  readonly workload: OwnerLeaseWorkload;
  /** The normalized mailbox, drive owner, site or team id. */
  readonly owner_id: string;
}

/**
 * Opens the tenant with its data key, without provisioning it, takes the owner's lease, and runs
 * one deletion that reads manifests under it, so it never interleaves with a backup of the same
 * owner (issue #623).
 *
 * @throws OwnerBusyError when another operation holds the owner.
 */
export async function run_owner_deletion<T>(
  ports: LeasedDeletionPorts,
  tenant_id: string,
  owner: DeletionOwner,
  run: (ctx: TenantContext, lease: HeldOwnerLease) => Promise<T>,
): Promise<T> {
  const ctx = await ports.tenant_factory.create_readonly(tenant_id);
  try {
    return await run_with_owner_lease(
      ports.leases,
      ctx,
      { ...owner, operation: 'delete' },
      (lease) => run(ctx, lease),
    );
  } finally {
    ctx.destroy();
  }
}

/**
 * Opens the tenant as raw storage, takes the owner's lease, and runs a deletion that only removes
 * objects by key. Neither the lease nor the deletion needs the tenant key, so an owner can be
 * erased when the data key is missing or the passphrase is lost.
 *
 * @throws OwnerBusyError when another operation holds the owner.
 * @throws NotFoundError when the tenant has no bucket.
 */
export async function run_owner_erasure<T>(
  ports: LeasedDeletionPorts,
  tenant_id: string,
  owner: DeletionOwner,
  run: (storage: ObjectStorage, lease: HeldOwnerLease) => Promise<T>,
): Promise<T> {
  const ctx = await ports.tenant_factory.create_storage_only(tenant_id);
  return run_with_owner_lease(ports.leases, ctx, { ...owner, operation: 'delete' }, (lease) =>
    run(ctx.storage, lease),
  );
}

/**
 * Erases every version under an owner's scopes while its lease is held, then the lease object's
 * own versions.
 *
 * The lease is skipped by the main sweep, because an owner's `_meta` prefix contains it and
 * removing it first would let a backup start in the middle of the erasure. It goes last, by
 * version, so a versioned bucket keeps no noncurrent lease versions or delete marker under the
 * erased owner's id. That last sweep is not counted in the result: a lease is not backup data.
 */
export async function erase_leased_owner_scopes(
  storage: DeletionStorage,
  lease: HeldOwnerLease,
  scopes: readonly string[],
): Promise<DeletionResult> {
  lease.assert_held();
  const result = await delete_scopes(storage, scopes, [lease.storage_key]);
  await erase_lease_versions(storage, lease.storage_key);
  return result;
}

/** Removes every version of the lease object; a failure is logged and the lease expires instead. */
async function erase_lease_versions(storage: DeletionStorage, lease_key: string): Promise<void> {
  try {
    await delete_scopes(storage, [lease_key]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not remove the versions of the lease at ${lease_key}: ${reason}`);
  }
}
