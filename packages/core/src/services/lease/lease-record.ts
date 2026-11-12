import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { LeaseWorkload, OwnerLeaseHolder } from '@wisecom/atlas-types';

/**
 * How long a lease stays valid after its last write. A killed holder blocks its owner for at most
 * this long. Long enough that a slow S3 round trip or a busy event loop never lets a healthy run's
 * lease lapse between renewals.
 */
export const LEASE_TTL_MS = 10 * 60 * 1000;

/** How often a holder renews. Five chances to renew before the TTL runs out. */
export const LEASE_RENEW_INTERVAL_MS = 2 * 60 * 1000;

/** Every lease lives under this prefix, outside every workload's own tree. */
export const LEASE_PREFIX = '_meta/leases/';

/** The tenant lease, held by purge and DEK re-wrap. */
export const TENANT_LEASE_KEY = `${LEASE_PREFIX}tenant.json`;

const RECORD_FORMAT = 1;

/** The lease object's body. Plaintext JSON: it carries no tenant content, only who holds it. */
export interface LeaseRecord extends OwnerLeaseHolder {
  readonly format: number;
  /** Random per run. The only field that proves a lease is ours. */
  readonly token: string;
  readonly renewed_at: string;
}

/** Who this process is and what it is doing, fixed for one held lease. */
export interface LeaseIdentity {
  readonly token: string;
  readonly operation: string;
  readonly host: string;
  readonly pid: number;
  readonly started_at: string;
}

/**
 * Key of one owner's lease. The owner id is URI-encoded so a SharePoint site id or any other
 * character an id may carry stays one path segment.
 */
export function owner_lease_key(workload: LeaseWorkload, owner_id: string): string {
  if (owner_id.length === 0) throw new Error('Cannot lease an empty owner id');
  return `${LEASE_PREFIX}${workload}/${encodeURIComponent(owner_id)}.json`;
}

/** A fresh identity for one run of `operation`. */
export function new_lease_identity(operation: string, now_ms: number): LeaseIdentity {
  return {
    token: randomBytes(16).toString('hex'),
    operation,
    host: hostname(),
    pid: process.pid,
    started_at: new Date(now_ms).toISOString(),
  };
}

/** Serializes the record a holder writes at `now_ms`, valid for one TTL from then. */
export function encode_lease_record(identity: LeaseIdentity, now_ms: number): Buffer {
  const record: LeaseRecord = {
    format: RECORD_FORMAT,
    ...identity,
    renewed_at: new Date(now_ms).toISOString(),
    expires_at: new Date(now_ms + LEASE_TTL_MS).toISOString(),
  };
  return Buffer.from(JSON.stringify(record));
}

/**
 * Parses a stored lease, or returns undefined when the body is not a lease this build understands.
 * An unreadable lease is treated as expired by the caller, so a damaged object cannot block an
 * owner forever; takeover is still a compare-and-swap on its ETag.
 */
export function decode_lease_record(body: Buffer): LeaseRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const fields = parsed as Record<string, unknown>;
  const strings = ['token', 'operation', 'host', 'started_at', 'renewed_at', 'expires_at'];
  if (!strings.every((name) => typeof fields[name] === 'string')) return undefined;
  if (typeof fields.pid !== 'number' || typeof fields.format !== 'number') return undefined;
  if (Number.isNaN(Date.parse(fields.expires_at as string))) return undefined;
  return parsed as LeaseRecord;
}

/** Whether a stored lease still excludes other runs at `now_ms`. */
export function is_lease_live(record: LeaseRecord | undefined, now_ms: number): boolean {
  return record !== undefined && Date.parse(record.expires_at) > now_ms;
}

/** The holder fields an operator needs from a record, without the token. */
export function describe_holder(record: LeaseRecord | undefined): OwnerLeaseHolder | undefined {
  if (record === undefined) return undefined;
  const { operation, host, pid, started_at, expires_at } = record;
  return { operation, host, pid, started_at, expires_at };
}
