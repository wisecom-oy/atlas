import type { TenantStorageContext } from '@/ports/tenant/context.port';

/** The workloads whose per-owner state a lease protects. Also the lease's storage namespace. */
export type OwnerLeaseWorkload =
  'outlook' | 'onedrive' | 'sharepoint' | 'contacts' | 'calendar' | 'teams';

/**
 * The operations that take the lease: those that write per-owner state, and restore, which reads it
 * while a delete or another restore of the same owner would change what it restores.
 */
export type OwnerLeaseOperation = 'backup' | 'delete' | 'quarantine' | 'restore';

/** Which owner an operation needs exclusively, and what the operation is. */
export interface OwnerLeaseRequest {
  readonly workload: OwnerLeaseWorkload;
  /** The normalized mailbox, drive owner, site or team id, exactly as the workload's keys use it. */
  readonly owner_id: string;
  readonly operation: OwnerLeaseOperation;
}

/** A lease this run holds on one owner until it releases it. */
export interface HeldOwnerLease {
  /** The key of the lease object, so an owner erasure can leave it for last. */
  readonly storage_key: string;

  /**
   * Fails unless this run still holds the lease. Call it before each write that advances durable
   * state: the manifest or index, the cursor, a deletion. An in-memory check, no storage request.
   *
   * @throws OwnerLeaseLostError when the lease was lost or ran out without a renewal.
   */
  assert_held(): void;

  /** Stops renewing and deletes the lease when it is still this run's. Never rejects. */
  release(): Promise<void>;
}

/**
 * Mutual exclusion between operations on one mailbox, drive owner, site or team of a tenant
 * (issue #623). Owners and workloads are independent: a lease on one never blocks another.
 */
export interface OwnerLeasePort {
  /**
   * Takes the owner's lease, or fails without writing anything else.
   *
   * `ctx` needs storage only, so a storage-only context works: the lease is not encrypted. It must
   * be the storage as the factory built it, never one decorated with a run's Object Lock
   * retention: a lease is rewritten every minute and deleted at the end.
   *
   * @throws OwnerBusyError when another operation holds a live lease on the owner.
   * @throws UnsupportedFormatVersionError when the lease in storage was written by a newer Atlas.
   */
  acquire(ctx: TenantStorageContext, request: OwnerLeaseRequest): Promise<HeldOwnerLease>;
}
