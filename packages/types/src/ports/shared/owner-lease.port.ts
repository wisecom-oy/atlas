import type { ObjectStorage } from '@/ports/storage/object-storage.port';

/** The workloads whose per-owner state a lease protects. One owner has one lease per workload. */
export type LeaseWorkload =
  'outlook' | 'onedrive' | 'sharepoint' | 'teams' | 'contacts' | 'calendar';

/** Operations that take an owner lease. */
export type OwnerLeaseOperation = 'backup' | 'restore' | 'delete';

/** Operations that take the tenant lease, which excludes every owner lease. */
export type TenantLeaseOperation = 'purge' | 'rewrap';

/** The owner a run holds exclusively, and what it is doing to it. */
export interface OwnerLeaseScope {
  readonly workload: LeaseWorkload;
  /** Normalized owner id: mailbox, drive owner, site or team. */
  readonly owner_id: string;
  readonly operation: OwnerLeaseOperation;
}

/** Anything that carries the tenant bucket's storage: a full tenant context or a storage-only one. */
export interface LeaseableContext {
  readonly storage: ObjectStorage;
}

/**
 * Single-run-per-owner guarantee. Each method holds a lease object in the tenant bucket for the
 * duration of `run` and hands `run` a copy of `ctx` whose storage refuses every write once the lease
 * is lost, so a run that overlapped another can never overwrite the other's cursors or pointers.
 */
export interface OwnerLeases {
  /**
   * Runs `run` while holding the owner's lease.
   *
   * @throws OwnerBusyError before `run` starts when another run holds the owner or the tenant.
   * @throws OwnerLeaseLostError when the lease was lost while `run` was working.
   */
  run_exclusive<C extends LeaseableContext, T>(
    ctx: C,
    scope: OwnerLeaseScope,
    run: (leased: C) => Promise<T>,
  ): Promise<T>;

  /**
   * As {@link run_exclusive}, except that storage credentials without write access run `run`
   * unleased with a warning. For restore, which only reads the bucket and has always worked with
   * read-only storage credentials.
   */
  run_exclusive_when_writable<C extends LeaseableContext, T>(
    ctx: C,
    scope: OwnerLeaseScope,
    run: (leased: C) => Promise<T>,
  ): Promise<T>;

  /**
   * Runs `run` while holding the tenant lease. Refuses while any owner lease is live, and every
   * owner run refuses while the tenant lease is live.
   */
  run_tenant_exclusive<C extends LeaseableContext, T>(
    ctx: C,
    operation: TenantLeaseOperation,
    run: (leased: C) => Promise<T>,
  ): Promise<T>;
}
