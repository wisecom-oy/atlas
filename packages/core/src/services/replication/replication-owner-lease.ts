import type {
  OwnerLeaseOperation,
  OwnerLeasePort,
  OwnerLeaseWorkload,
  StorageTarget,
  TenantContextFactory,
  TenantStorageContext,
} from '@wisecom/atlas-types';
import { run_with_owner_lease } from '@/services/lease/run-with-owner-lease';
import { ensure_source_dek_on_primary } from '@/services/replication/dek-rehydration-validator';

/** The owner a replication or rehydration acts on, normalized as the workload's keys use it. */
export interface ReplicationLeaseOwner {
  readonly workload: OwnerLeaseWorkload;
  readonly owner_id: string;
}

/** What a rehydration needs to install the source key and hold the owner's lease on primary. */
export interface RehydrationLeasePorts {
  readonly leases: OwnerLeasePort;
  readonly tenant_factory: TenantContextFactory;
  readonly primary: StorageTarget;
}

/**
 * Runs a replication while holding the lease of every owner it acts on, on the source (primary)
 * bucket, which is where it reads and where its status records go. Target buckets take no lease.
 * The leases are taken in the order given, and all of them before `run` starts.
 *
 * @throws OwnerBusyError when another operation holds any of the owners, before anything is written.
 */
export function run_replication_under_lease<T>(
  leases: OwnerLeasePort,
  tenant_factory: TenantContextFactory,
  tenant_id: string,
  owners: ReplicationLeaseOwner | readonly ReplicationLeaseOwner[],
  run: () => Promise<T>,
): Promise<T> {
  return run_under_primary_leases(
    leases,
    tenant_factory,
    tenant_id,
    { owners: as_list(owners), operation: 'replicate' },
    run,
  );
}

/**
 * Runs a rehydration while holding the lease of every owner it acts on, on the primary bucket,
 * which is what it writes. The leases are taken in the order given, all before `run` starts.
 *
 * The source key is installed on primary first, and outside the lease. Installing it writes the
 * key object into primary, and the replace path only proceeds when the bucket holds nothing but
 * that key, so a lease object written earlier would make a rerun into an empty bucket refuse.
 * A busy owner always has a key on primary already, so this step writes nothing for it.
 *
 * @throws OwnerBusyError when another operation holds any of the owners, before the rehydration writes.
 */
export async function run_rehydration_under_lease<T>(
  ports: RehydrationLeasePorts,
  tenant_id: string,
  source: StorageTarget,
  owners: ReplicationLeaseOwner | readonly ReplicationLeaseOwner[],
  run: () => Promise<T>,
): Promise<T> {
  await ensure_source_dek_on_primary(ports.primary, source, tenant_id);
  return run_under_primary_leases(
    ports.leases,
    ports.tenant_factory,
    tenant_id,
    { owners: as_list(owners), operation: 'rehydrate' },
    run,
  );
}

/** The owners one run leases, and what it is doing to them. */
interface LeaseSet {
  readonly owners: readonly ReplicationLeaseOwner[];
  readonly operation: OwnerLeaseOperation;
}

/** Opens primary as storage only, which the leases need, and runs `run` under every lease. */
async function run_under_primary_leases<T>(
  leases: OwnerLeasePort,
  tenant_factory: TenantContextFactory,
  tenant_id: string,
  lease_set: LeaseSet,
  run: () => Promise<T>,
): Promise<T> {
  const ctx = await tenant_factory.create_storage_only(tenant_id);
  return run_under_each_lease(leases, ctx, lease_set, 0, run);
}

/**
 * Takes the lease of `owners[index]`, then the rest in order, and runs `run` inside them all.
 * Each lease is released when its scope ends, however `run` or a later acquisition ends.
 */
function run_under_each_lease<T>(
  leases: OwnerLeasePort,
  ctx: TenantStorageContext,
  lease_set: LeaseSet,
  index: number,
  run: () => Promise<T>,
): Promise<T> {
  const owner = lease_set.owners[index];
  if (owner === undefined) return run();
  return run_with_owner_lease(leases, ctx, { ...owner, operation: lease_set.operation }, () =>
    run_under_each_lease(leases, ctx, lease_set, index + 1, run),
  );
}

function as_list(
  owners: ReplicationLeaseOwner | readonly ReplicationLeaseOwner[],
): readonly ReplicationLeaseOwner[] {
  return 'workload' in owners ? [owners] : owners;
}
