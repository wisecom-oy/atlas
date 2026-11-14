import type {
  OwnerLeasePort,
  OwnerLeaseRequest,
  OwnerLeaseWorkload,
  StorageTarget,
  TenantContextFactory,
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
 * Runs a replication of one owner while holding that owner's lease on the source (primary)
 * bucket, which is where it reads and where its status record goes. Target buckets take no lease.
 *
 * @throws OwnerBusyError when another operation holds the owner, before anything is written.
 */
export function run_replication_under_lease<T>(
  leases: OwnerLeasePort,
  tenant_factory: TenantContextFactory,
  tenant_id: string,
  owner: ReplicationLeaseOwner,
  run: () => Promise<T>,
): Promise<T> {
  return run_under_primary_lease(
    leases,
    tenant_factory,
    tenant_id,
    { ...owner, operation: 'replicate' },
    run,
  );
}

/**
 * Runs a rehydration of one owner while holding that owner's lease on the primary bucket, which
 * is what it writes.
 *
 * The source key is installed on primary first, and outside the lease. Installing it writes the
 * key object into primary, and the replace path only proceeds when the bucket holds nothing but
 * that key, so a lease object written earlier would make a rerun into an empty bucket refuse.
 * A busy owner always has a key on primary already, so this step writes nothing for it.
 *
 * @throws OwnerBusyError when another operation holds the owner, before the rehydration writes.
 */
export async function run_rehydration_under_lease<T>(
  ports: RehydrationLeasePorts,
  tenant_id: string,
  source: StorageTarget,
  owner: ReplicationLeaseOwner,
  run: () => Promise<T>,
): Promise<T> {
  await ensure_source_dek_on_primary(ports.primary, source, tenant_id);
  return run_under_primary_lease(
    ports.leases,
    ports.tenant_factory,
    tenant_id,
    { ...owner, operation: 'rehydrate' },
    run,
  );
}

/** Opens primary as storage only, which the lease needs, and runs `run` under the lease. */
async function run_under_primary_lease<T>(
  leases: OwnerLeasePort,
  tenant_factory: TenantContextFactory,
  tenant_id: string,
  request: OwnerLeaseRequest,
  run: () => Promise<T>,
): Promise<T> {
  const ctx = await tenant_factory.create_storage_only(tenant_id);
  return run_with_owner_lease(leases, ctx, request, run);
}
