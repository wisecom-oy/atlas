import type { OwnerLeaseWorkload, TenantStorageContext } from '@wisecom/atlas-types';
import { owner_id_of_lease_key, owner_lease_prefix } from '@/services/lease/owner-lease-key';
import { read_live_owner_lease, type OwnerLeaseRecord } from '@/services/lease/owner-lease-record';

type OwnedWorkload = Exclude<OwnerLeaseWorkload, 'tenant'>;

/** Every workload that takes owner leases, in the order the scan visits them. */
const OWNED_WORKLOADS: readonly OwnedWorkload[] = [
  'outlook',
  'onedrive',
  'sharepoint',
  'contacts',
  'calendar',
  'teams',
];

/** A live owner lease the scan found, with the owner it covers. */
export interface LiveOwnerLease {
  readonly workload: OwnedWorkload;
  readonly owner_id: string;
  readonly record: OwnerLeaseRecord;
}

/**
 * Finds the first live owner lease in the tenant, reading only the lease objects the listings
 * name. Each workload's listing is one request per page; a candidate that is not exactly an owner
 * lease key is skipped without a read.
 *
 * @throws UnsupportedFormatVersionError when a lease was written by a newer Atlas.
 */
export async function find_live_owner_lease(
  ctx: TenantStorageContext,
  now_ms: number,
): Promise<LiveOwnerLease | undefined> {
  for (const workload of OWNED_WORKLOADS) {
    const found = await find_live_lease_in_workload(ctx, workload, now_ms);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function find_live_lease_in_workload(
  ctx: TenantStorageContext,
  workload: OwnedWorkload,
  now_ms: number,
): Promise<LiveOwnerLease | undefined> {
  for (const key of await ctx.storage.list(owner_lease_prefix(workload))) {
    const owner_id = owner_id_of_lease_key(workload, key);
    if (owner_id === undefined) continue;
    const record = await read_live_owner_lease(ctx, key, now_ms);
    if (record !== undefined) return { workload, owner_id, record };
  }
  return undefined;
}
