import { OwnerBusyError, type ObjectStorage } from '@wisecom/atlas-types';
import { HeldLease } from '@/services/lease/held-lease';
import {
  create_lease_object,
  read_stored_lease,
  replace_lease_object,
  type StoredLease,
} from '@/services/lease/lease-object-store';
import {
  describe_holder,
  encode_lease_record,
  is_lease_live,
  LEASE_PREFIX,
  LEASE_TTL_MS,
  new_lease_identity,
  TENANT_LEASE_KEY,
} from '@/services/lease/lease-record';
import { is_precondition_failure } from '@/services/shared/precondition-failure';
import { logger } from '@/utils/logger';

/**
 * Takes the lease at `key` for `operation`, or rejects with `OwnerBusyError` while another run
 * holds it.
 *
 * Reads first, then writes conditionally, then reads back. The conditional write (create-only, or
 * compare-and-swap on an expired lease's ETag) is what makes two simultaneous starts safe. The read
 * before it is what still catches a live lease on a backend that ignores conditional writes, and the
 * read back catches the last writer winning on such a backend.
 */
export async function acquire_lease(
  storage: ObjectStorage,
  key: string,
  operation: string,
): Promise<HeldLease> {
  const existing = await read_stored_lease(storage, key);
  if (existing !== undefined && is_lease_live(existing.record, Date.now())) {
    throw new OwnerBusyError(key, describe_holder(existing.record));
  }
  if (existing !== undefined) log_takeover(key, existing);

  const sent_at = Date.now();
  const identity = new_lease_identity(operation, sent_at);
  const body = encode_lease_record(identity, sent_at);
  try {
    if (existing === undefined) await create_lease_object(storage, key, body);
    else await replace_lease_object(storage, key, body, existing.etag);
  } catch (err) {
    if (!is_precondition_failure(err)) throw err;
    throw await busy_with_current_holder(storage, key, err);
  }

  const written = await read_stored_lease(storage, key);
  if (written?.record?.token !== identity.token) {
    throw new OwnerBusyError(key, describe_holder(written?.record));
  }
  return new HeldLease(storage, key, identity, sent_at + LEASE_TTL_MS);
}

/** @throws OwnerBusyError when purge or re-wrap holds the tenant lease. */
export async function refuse_during_tenant_lease(storage: ObjectStorage): Promise<void> {
  const tenant = await read_stored_lease(storage, TENANT_LEASE_KEY);
  if (tenant !== undefined && is_lease_live(tenant.record, Date.now())) {
    throw new OwnerBusyError(TENANT_LEASE_KEY, describe_holder(tenant.record));
  }
}

/**
 * @throws OwnerBusyError naming the first live owner lease. Leases are deleted when their run ends,
 * so the listing holds only running and crashed runs.
 */
export async function refuse_during_owner_leases(storage: ObjectStorage): Promise<void> {
  const keys = await storage.list(LEASE_PREFIX);
  for (const key of keys) {
    if (key === TENANT_LEASE_KEY) continue;
    const stored = await read_stored_lease(storage, key);
    if (stored !== undefined && is_lease_live(stored.record, Date.now())) {
      throw new OwnerBusyError(key, describe_holder(stored.record));
    }
  }
}

async function busy_with_current_holder(
  storage: ObjectStorage,
  key: string,
  cause: unknown,
): Promise<OwnerBusyError> {
  const current = await read_stored_lease(storage, key);
  return new OwnerBusyError(key, describe_holder(current?.record), { cause });
}

function log_takeover(key: string, expired: StoredLease): void {
  if (expired.record === undefined) {
    logger.warn(`Run lease ${key} is unreadable; replacing it`);
    return;
  }
  const { operation, host, pid, expires_at } = expired.record;
  logger.warn(
    `Run lease ${key} from ${operation} on ${host} (pid ${pid}) expired at ${expires_at}; ` +
      'taking it over. That run either crashed or was force-stopped.',
  );
}
