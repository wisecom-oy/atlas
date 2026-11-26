import type { OwnerLeaseOperation, OwnerLeaseWorkload } from '@/ports/lease/owner-lease.port';

/** One scope an operation needs exclusively, as Atlas asks a host-supplied exclusion for it. */
export interface OwnerExclusionRequest {
  readonly tenantId: string;
  /** The workload whose owner the operation needs, or `tenant` for the tenant-wide scope. */
  readonly workload: OwnerLeaseWorkload;
  /** The normalized mailbox, drive owner, site or team id; the tenant id for `tenant`. */
  readonly ownerId: string;
  readonly operation: OwnerLeaseOperation;
}

/** The scope was granted. Atlas calls `release` exactly once, however the operation ends. */
export interface OwnerExclusionGrant {
  readonly acquired: true;
  /** Gives the scope back. A rejection is logged and never masks the operation's own outcome. */
  release(): Promise<void>;
  /**
   * Optional. Answers whether the host still grants the scope. Atlas calls it before each write
   * that advances durable state (manifest, index, cursor, deletion) and stops with
   * `OwnerLeaseLostError` when it returns false. Must answer from local state: it is synchronous.
   */
  isHeld?(): boolean;
}

/** The scope is held by another operation. Atlas fails with `OwnerBusyError` and writes nothing. */
export interface OwnerExclusionRefusal {
  readonly acquired: false;
  /** The operation that holds the scope, when the host knows it. */
  readonly heldByOperation?: OwnerLeaseOperation;
  /** ISO 8601 time the holder's claim ends, when the host knows it. Reported as `lease_expires_at`. */
  readonly busyUntil?: string;
}

export type OwnerExclusionResult = OwnerExclusionGrant | OwnerExclusionRefusal;

/**
 * Keeps two operations off one owner, supplied by a host that already serialises its own work
 * (issue #974). When an instance is given one, Atlas asks it wherever it would take a storage lease
 * and writes no lease object, and conditional writes are checked by Atlas instead of being sent to
 * the backend, so a backend without conditional `PUT` on versioned buckets can be used.
 *
 * The host must uphold the same rules as the storage lease:
 *
 * - Two grants for the same `workload` and `ownerId` of one tenant never overlap.
 * - A `tenant` grant never overlaps any other grant of that tenant, in any process.
 * - A grant stays valid until `release`, or until `isHeld` returns false.
 *
 * Atlas does not retry a refusal. A rejected `acquire` fails the operation with that error before
 * anything is written.
 */
export interface OwnerExclusion {
  acquire(request: OwnerExclusionRequest): Promise<OwnerExclusionResult>;
}
