import type { TenantStorageContext } from '@wisecom/atlas-types';
import { StorageError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import { is_absent_object_error } from '@/services/shared/absent-object';
import { is_precondition_failure } from '@/services/shared/precondition-failure';

/** The lease body format this build writes and reads. */
export const OWNER_LEASE_FORMAT_VERSION = 1;

/**
 * The body of a lease object, stored as plain UTF-8 JSON. It is not encrypted, so that an operation
 * without the tenant key, such as erasing an owner, can still take the lease. It names a run, never
 * a person or a machine: no hostname, user name or process id is stored.
 */
export interface OwnerLeaseRecord {
  readonly format_version: number;
  /** Random id of the run that holds the owner. */
  readonly holder_id: string;
  /** What the holder is doing: `backup`, `delete`, `quarantine`, `restore`, `replicate`, `rehydrate`, or `purge` and `rewrap` on the tenant lease. */
  readonly operation: string;
  /** ISO 8601 UTC time the holder first took the lease. */
  readonly acquired_at: string;
  /** ISO 8601 UTC time the lease runs out unless the holder rewrites it first. */
  readonly expires_at: string;
  /**
   * Set when the holder finished and could not delete the lease, for example under a bucket policy
   * that denies `DeleteObject` on `_meta/*`. A record that carries it is free to take.
   */
  readonly released_at?: string | undefined;
}

/** A lease object as stored: its ETag, and its body unless the object is damaged. */
export interface StoredOwnerLease {
  readonly etag: string;
  /** Undefined when the object does not parse or lacks the lease shape. */
  readonly record: OwnerLeaseRecord | undefined;
}

/** The condition a lease write carries. A lease is never written unconditionally. */
export type OwnerLeaseWriteCondition =
  { readonly create_only: true } | { readonly if_match: string };

/**
 * Reads the lease object with its ETag; `undefined` when there is none.
 *
 * A damaged object is returned with its ETag and no record, so the caller can replace exactly that
 * object. One a newer Atlas wrote raises `UnsupportedFormatVersionError`: it is intact, and
 * treating it as damage would take an owner over from a running newer version.
 *
 * @throws StorageError when the read fails for any reason other than absence.
 */
export async function read_owner_lease(
  ctx: TenantStorageContext,
  key: string,
): Promise<StoredOwnerLease | undefined> {
  let stored: { data: Buffer; etag: string };
  try {
    stored = await ctx.storage.get_with_etag(key);
  } catch (err) {
    if (is_absent_object_error(err)) return undefined;
    throw new StorageError(`Could not read the owner lease at ${key}`, { cause: err });
  }
  return { etag: stored.etag, record: decode_owner_lease(key, stored.data) };
}

/** Parses and checks a lease body; undefined for damage, and rejects for a newer format. */
function decode_owner_lease(key: string, payload: Buffer): OwnerLeaseRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf-8')) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const body = parsed as Record<string, unknown>;
  if (typeof body.format_version === 'number' && body.format_version > OWNER_LEASE_FORMAT_VERSION) {
    throw new UnsupportedFormatVersionError(
      `The owner lease at ${key} was written by a newer Atlas (lease format ` +
        `${body.format_version}, this build reads ${OWNER_LEASE_FORMAT_VERSION})`,
    );
  }
  return is_owner_lease_record(body) ? body : undefined;
}

function is_owner_lease_record(
  body: Record<string, unknown>,
): body is Record<string, unknown> & OwnerLeaseRecord {
  return (
    body.format_version === OWNER_LEASE_FORMAT_VERSION &&
    typeof body.holder_id === 'string' &&
    body.holder_id !== '' &&
    typeof body.operation === 'string' &&
    typeof body.acquired_at === 'string' &&
    typeof body.expires_at === 'string' &&
    Number.isFinite(Date.parse(body.expires_at)) &&
    (body.released_at === undefined || typeof body.released_at === 'string')
  );
}

/**
 * Whether a lease blocks others at `now_ms`: it is intact, not released, and not yet expired. A
 * damaged object (no record) blocks nobody, the same rule the acquirer applies.
 */
export function is_live_owner_lease(record: OwnerLeaseRecord | undefined, now_ms: number): boolean {
  if (record === undefined || record.released_at !== undefined) return false;
  return Date.parse(record.expires_at) > now_ms;
}

/**
 * Reads the lease at `key` and returns its record only when it is live at `now_ms`.
 *
 * @throws UnsupportedFormatVersionError when the lease was written by a newer Atlas.
 */
export async function read_live_owner_lease(
  ctx: TenantStorageContext,
  key: string,
  now_ms: number,
): Promise<OwnerLeaseRecord | undefined> {
  const record = (await read_owner_lease(ctx, key))?.record;
  return is_live_owner_lease(record, now_ms) ? record : undefined;
}

/**
 * Writes the lease under its condition and reports whether storage accepted it. Always sent
 * without an Object Lock policy: a lease is rewritten every minute and deleted at the end.
 *
 * A compare-and-swap on a key that no longer exists is refused like a stale ETag.
 */
export async function put_owner_lease(
  ctx: TenantStorageContext,
  key: string,
  record: OwnerLeaseRecord,
  condition: OwnerLeaseWriteCondition,
): Promise<'written' | 'refused'> {
  const body = Buffer.from(JSON.stringify(record), 'utf-8');
  const if_match = 'if_match' in condition ? condition.if_match : undefined;
  try {
    await ctx.storage.put(key, body, undefined, undefined, if_match, if_match === undefined);
  } catch (err) {
    if (is_precondition_failure(err)) return 'refused';
    if (if_match !== undefined && is_absent_object_error(err)) return 'refused';
    throw err;
  }
  return 'written';
}
