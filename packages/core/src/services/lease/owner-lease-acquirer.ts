import type { OwnerLeaseRequest, TenantStorageContext } from '@wisecom/atlas-types';
import { OwnerBusyError, StorageError } from '@wisecom/atlas-types';
import {
  OWNER_LEASE_FORMAT_VERSION,
  put_owner_lease,
  read_owner_lease,
  type OwnerLeaseRecord,
  type OwnerLeaseWriteCondition,
  type StoredOwnerLease,
} from '@/services/lease/owner-lease-record';
import { OWNER_LEASE_TTL_MS, type OwnerLeaseRuntime } from '@/services/lease/owner-lease-timing';
import { logger } from '@/utils/logger';

/** How often an acquire starts over when the lease object keeps vanishing under it. */
const MAX_ACQUIRE_ATTEMPTS = 3;

/** The lease as this run wrote it and storage confirmed it. */
export interface AcquiredOwnerLease {
  readonly key: string;
  readonly record: OwnerLeaseRecord;
}

/**
 * Takes the owner's lease: a create-only write, or a compare-and-swap over a lease that expired or
 * is damaged. Every successful write is read back, and the run holds the lease only when the
 * stored holder id is its own, which also catches a backend that ignores the write conditions.
 *
 * @throws OwnerBusyError when another operation holds a live lease, or won the race for a dead one.
 */
export async function acquire_owner_lease(
  ctx: TenantStorageContext,
  request: OwnerLeaseRequest,
  key: string,
  runtime: OwnerLeaseRuntime,
): Promise<AcquiredOwnerLease> {
  const holder_id = runtime.new_holder_id();
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const record = new_lease_record(request, holder_id, runtime.now());
    if ((await put_owner_lease(ctx, key, record, { create_only: true })) === 'written') {
      return confirm_lease_is_stored(ctx, request, key, record);
    }
    const existing = await read_owner_lease(ctx, key);
    // Released between the refused create and the read: the owner is free, so start over.
    if (existing === undefined) continue;
    return take_existing_lease(ctx, request, key, record, existing, runtime.now());
  }
  throw new OwnerBusyError({ workload: request.workload, owner_id: request.owner_id });
}

function new_lease_record(
  request: OwnerLeaseRequest,
  holder_id: string,
  now_ms: number,
): OwnerLeaseRecord {
  return {
    format_version: OWNER_LEASE_FORMAT_VERSION,
    holder_id,
    operation: request.operation,
    acquired_at: new Date(now_ms).toISOString(),
    expires_at: new Date(now_ms + OWNER_LEASE_TTL_MS).toISOString(),
  };
}

/**
 * Decides what a refused create found. A live lease is the busy owner. An expired, damaged or
 * released one is replaced with a compare-and-swap on the ETag just read, so of several runs that
 * find the same free lease exactly one wins.
 */
async function take_existing_lease(
  ctx: TenantStorageContext,
  request: OwnerLeaseRequest,
  key: string,
  record: OwnerLeaseRecord,
  existing: StoredOwnerLease,
  now_ms: number,
): Promise<AcquiredOwnerLease> {
  // The storage client retries a PUT whose response was lost, and the retry is refused by the
  // object its first attempt created.
  if (existing.record?.holder_id === record.holder_id) return { key, record: existing.record };
  // A holder that could not delete its lease marked it released: free, whatever its expiry says.
  const released = existing.record?.released_at !== undefined;
  if (
    existing.record !== undefined &&
    !released &&
    Date.parse(existing.record.expires_at) > now_ms
  ) {
    throw owner_busy_error(request, existing.record);
  }
  // The warning is for a holder that died. A released lease was given back in good order.
  if (!released) warn_about_takeover(request, key, existing.record);
  return replace_dead_lease(ctx, request, key, record, { if_match: existing.etag });
}

/** Swaps this run's lease in for a dead one; a refused swap means another run got there first. */
async function replace_dead_lease(
  ctx: TenantStorageContext,
  request: OwnerLeaseRequest,
  key: string,
  record: OwnerLeaseRecord,
  condition: OwnerLeaseWriteCondition,
): Promise<AcquiredOwnerLease> {
  if ((await put_owner_lease(ctx, key, record, condition)) === 'written') {
    return confirm_lease_is_stored(ctx, request, key, record);
  }
  const winner = await read_owner_lease(ctx, key);
  if (winner?.record?.holder_id === record.holder_id) return { key, record: winner.record };
  throw owner_busy_error(request, winner?.record);
}

/** Reads the lease back and requires the stored holder to be this run. */
async function confirm_lease_is_stored(
  ctx: TenantStorageContext,
  request: OwnerLeaseRequest,
  key: string,
  record: OwnerLeaseRecord,
): Promise<AcquiredOwnerLease> {
  const stored = await read_owner_lease(ctx, key);
  if (stored?.record?.holder_id === record.holder_id) return { key, record };
  if (stored?.record !== undefined) throw owner_busy_error(request, stored.record);
  throw new StorageError(
    `The owner lease at ${key} was written but reading it back returned ` +
      `${stored === undefined ? 'no object' : 'an unreadable object'}`,
  );
}

function owner_busy_error(
  request: OwnerLeaseRequest,
  holder: OwnerLeaseRecord | undefined,
): OwnerBusyError {
  return new OwnerBusyError({
    workload: request.workload,
    owner_id: request.owner_id,
    held_by_operation: holder?.operation,
    lease_expires_at: holder?.expires_at,
  });
}

function warn_about_takeover(
  request: OwnerLeaseRequest,
  key: string,
  dead: OwnerLeaseRecord | undefined,
): void {
  const what =
    dead === undefined
      ? 'a damaged lease'
      : `the lease a ${dead.operation} left behind, expired at ${dead.expires_at}`;
  logger.warn(`Taking over ${what} on ${request.workload} owner ${request.owner_id} (${key})`);
}
