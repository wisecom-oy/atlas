import type { ObjectStorage } from '@wisecom/atlas-types';
import { is_absent_object_error } from '@/services/shared/absent-object';
import { decode_lease_record, type LeaseRecord } from '@/services/lease/lease-record';

/** A lease object as stored: its parsed body (undefined when unreadable) and its ETag. */
export interface StoredLease {
  readonly record: LeaseRecord | undefined;
  readonly etag: string;
}

/** Reads a lease object, or returns undefined when there is none. */
export async function read_stored_lease(
  storage: ObjectStorage,
  key: string,
): Promise<StoredLease | undefined> {
  try {
    const { data, etag } = await storage.get_with_etag(key);
    return { record: decode_lease_record(data), etag };
  } catch (err) {
    if (is_absent_object_error(err)) return undefined;
    throw err;
  }
}

/** Creates a lease object only if none exists (If-None-Match: *). Rejects with a 412 otherwise. */
export async function create_lease_object(
  storage: ObjectStorage,
  key: string,
  body: Buffer,
): Promise<void> {
  await storage.put(key, body, undefined, undefined, undefined, true);
}

/** Replaces a lease object only while it still carries `etag` (If-Match). Rejects with a 412 otherwise. */
export async function replace_lease_object(
  storage: ObjectStorage,
  key: string,
  body: Buffer,
  etag: string,
): Promise<void> {
  await storage.put(key, body, undefined, undefined, etag);
}
