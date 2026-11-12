import type {
  DeletionResult,
  LeaseWorkload,
  ObjectStorage,
  OwnerLeases,
  TenantContextFactory,
} from '@wisecom/atlas-types';

/** What a deletion needs to open the tenant's storage and take the owner's lease. */
export interface LeasedDeletionDeps {
  readonly tenant_factory: TenantContextFactory;
  readonly leases: OwnerLeases;
}

/**
 * Opens the tenant bucket as raw storage and runs `remove` while holding the owner's lease, so a
 * deletion never runs under a backup or restore of the same owner.
 *
 * @throws OwnerBusyError before anything is deleted when another run holds the owner.
 */
export async function delete_under_owner_lease(
  deps: LeasedDeletionDeps,
  tenant_id: string,
  workload: LeaseWorkload,
  owner_id: string,
  remove: (storage: ObjectStorage) => Promise<DeletionResult>,
): Promise<DeletionResult> {
  const storage_ctx = await deps.tenant_factory.create_storage_only(tenant_id);
  return deps.leases.run_exclusive(
    storage_ctx,
    { workload, owner_id, operation: 'delete' },
    (leased) => remove(leased.storage),
  );
}
