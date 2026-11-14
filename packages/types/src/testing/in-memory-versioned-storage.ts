import { randomBytes } from 'node:crypto';
import type {
  ObjectStorage,
  ObjectStorageEtagResult,
  StorageObjectLockPolicy,
  StorageObjectVersion,
} from '@/index';

interface StoredVersion {
  readonly version_id: string;
  readonly body: Buffer;
  readonly etag: string;
}

/** A versioned in-memory bucket, for code that reads, lists or deletes object versions. */
export interface InMemoryVersionedStorage {
  readonly storage: ObjectStorage;
  /** Every version of `key`, oldest first. */
  readonly versions: (key: string) => readonly { version_id: string; body: Buffer }[];
  /**
   * Makes `delete_version` of this version throw `refusal`, the way a retention refuses it. The
   * caller supplies the error, so it is the class the code under test imports.
   */
  readonly lock: (version_id: string, refusal: Error) => void;
}

export interface InMemoryVersionedStorageOptions {
  /** Leave `get_version` off, as an adapter that cannot read versions would. */
  readonly without_get_version?: boolean;
  /** Leave `is_latest` out of listings, as a listing that does not state currency would. */
  readonly without_is_latest?: boolean;
}

function no_such_key(key: string): Error {
  return Object.assign(new Error(`NoSuchKey: ${key}`), { name: 'NoSuchKey' });
}

function precondition_failed(key: string): Error {
  return Object.assign(new Error(`PreconditionFailed: ${key}`), { name: 'PreconditionFailed' });
}

/**
 * Builds a bucket where every put adds a version and a plain delete removes the key's history,
 * honouring `if_match` and `if_none_match` against the current version.
 */
export function in_memory_versioned_storage(
  options: InMemoryVersionedStorageOptions = {},
): InMemoryVersionedStorage {
  const objects = new Map<string, StoredVersion[]>();
  const locked = new Map<string, Error>();
  let sequence = 0;

  const current = (key: string): StoredVersion | undefined => objects.get(key)?.at(-1);
  const read = (key: string): StoredVersion => {
    const found = current(key);
    if (!found) throw no_such_key(key);
    return found;
  };

  const storage = {
    async put(
      key: string,
      data: Buffer,
      _metadata?: Record<string, string>,
      _policy?: StorageObjectLockPolicy,
      if_match?: string,
      if_none_match?: boolean,
    ): Promise<void> {
      const held = current(key);
      if (if_none_match && held) throw precondition_failed(key);
      if (if_match !== undefined && held?.etag !== if_match) throw precondition_failed(key);
      const version: StoredVersion = {
        version_id: `v${++sequence}`,
        body: Buffer.from(data),
        etag: `"${randomBytes(8).toString('hex')}"`,
      };
      objects.set(key, [...(objects.get(key) ?? []), version]);
    },
    async get(key: string): Promise<Buffer> {
      return Buffer.from(read(key).body);
    },
    async get_with_etag(key: string): Promise<ObjectStorageEtagResult> {
      const found = read(key);
      return { data: Buffer.from(found.body), etag: found.etag };
    },
    async exists(key: string): Promise<boolean> {
      return current(key) !== undefined;
    },
    async delete(key: string): Promise<void> {
      objects.delete(key);
    },
    async list(prefix: string, limit?: number): Promise<string[]> {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      return limit === undefined ? keys : keys.slice(0, limit);
    },
    async list_versions(prefix: string): Promise<StorageObjectVersion[]> {
      const listed: StorageObjectVersion[] = [];
      for (const [key, versions] of objects) {
        if (!key.startsWith(prefix)) continue;
        versions.forEach((v, i) => {
          const base = { key, version_id: v.version_id, is_delete_marker: false };
          const is_latest = i === versions.length - 1;
          listed.push(options.without_is_latest ? base : { ...base, is_latest });
        });
      }
      return listed;
    },
    async delete_version(key: string, version_id: string): Promise<void> {
      const refusal = locked.get(version_id);
      if (refusal) throw refusal;
      objects.set(
        key,
        (objects.get(key) ?? []).filter((v) => v.version_id !== version_id),
      );
    },
    ...(options.without_get_version
      ? {}
      : {
          async get_version(key: string, version_id: string): Promise<Buffer> {
            const found = objects.get(key)?.find((v) => v.version_id === version_id);
            if (!found) throw no_such_key(key);
            return Buffer.from(found.body);
          },
        }),
  };

  return {
    storage: storage as unknown as ObjectStorage,
    versions: (key) =>
      (objects.get(key) ?? []).map((v) => ({ version_id: v.version_id, body: v.body })),
    lock: (version_id, refusal) => locked.set(version_id, refusal),
  };
}
