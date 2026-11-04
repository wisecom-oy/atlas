import { createCipheriv, createDecipheriv, createHmac, randomBytes, type Hmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  ObjectStorage,
  ObjectStorageEtagResult,
  StorageObjectLockPolicy,
  TenantContext,
} from '@/index';

/** An in-memory bucket plus the handle a test reads and writes it through. */
export interface InMemoryTenantContext {
  readonly ctx: TenantContext;
  /** Every stored key, sorted. */
  readonly keys: () => string[];
  /** The object as stored (ciphertext for encrypted objects), or undefined when absent. */
  readonly raw: (key: string) => Buffer | undefined;
  /** Overwrites or creates an object with raw bytes, bypassing encryption, to simulate damage. */
  readonly set_raw: (key: string, data: Buffer) => void;
  /** Removes an object, to simulate a missing shard or index. */
  readonly remove: (key: string) => void;
  /** Number of `destroy` calls on `ctx`. */
  readonly destroyed: () => number;
}

/** Stored-object key-value map with ETags, shared by every method of one harness. */
interface Bucket {
  readonly data: Map<string, { body: Buffer; etag: string }>;
}

/** Storage error shaped the way S3 reports a missing key, so `is_absent_object_error` matches. */
function no_such_key(key: string): Error {
  const err = new Error(`NoSuchKey: ${key}`);
  err.name = 'NoSuchKey';
  return err;
}

/** Storage error for a failed conditional write (HTTP 412). */
function precondition_failed(key: string): Error {
  const err = new Error(`PreconditionFailed: ${key}`);
  err.name = 'PreconditionFailed';
  return err;
}

function etag_of(body: Buffer): string {
  return `"${randomBytes(8).toString('hex')}-${body.length}"`;
}

/** Builds the storage half of the harness, honouring `if_match` and `if_none_match`. */
function build_storage(bucket: Bucket): ObjectStorage {
  const read = (key: string): { body: Buffer; etag: string } => {
    const stored = bucket.data.get(key);
    if (!stored) throw no_such_key(key);
    return stored;
  };
  const storage = {
    async put(
      key: string,
      data: Buffer,
      _metadata?: Record<string, string>,
      _object_lock_policy?: StorageObjectLockPolicy,
      if_match?: string,
      if_none_match?: boolean,
    ): Promise<void> {
      const current = bucket.data.get(key);
      if (if_none_match && current) throw precondition_failed(key);
      if (if_match !== undefined && current?.etag !== if_match) throw precondition_failed(key);
      bucket.data.set(key, { body: Buffer.from(data), etag: etag_of(data) });
    },
    async get(key: string): Promise<Buffer> {
      return Buffer.from(read(key).body);
    },
    async get_with_etag(key: string): Promise<ObjectStorageEtagResult> {
      const stored = read(key);
      return { data: Buffer.from(stored.body), etag: stored.etag };
    },
    async get_stream(key: string): Promise<NodeJS.ReadableStream> {
      return Readable.from([Buffer.from(read(key).body)]);
    },
    async delete(key: string): Promise<void> {
      bucket.data.delete(key);
    },
    async exists(key: string): Promise<boolean> {
      return bucket.data.has(key);
    },
    async list(prefix: string, limit?: number): Promise<string[]> {
      const keys = [...bucket.data.keys()].filter((key) => key.startsWith(prefix)).sort();
      return limit === undefined ? keys : keys.slice(0, limit);
    },
    async copy(source_key: string, dest_key: string): Promise<void> {
      const body = Buffer.from(read(source_key).body);
      bucket.data.set(dest_key, { body, etag: etag_of(body) });
    },
  };
  return storage as unknown as ObjectStorage;
}

/**
 * Builds a TenantContext over an in-memory bucket with real AES-256-GCM encryption. Each object is
 * bound to its storage key as AAD, so moving a ciphertext to another key fails to decrypt, the same
 * guarantee the production context gives (issue #350). Methods outside the Teams paths throw.
 */
export function in_memory_tenant_context(tenant_id = 'tenant-test'): InMemoryTenantContext {
  const bucket: Bucket = { data: new Map() };
  const key = randomBytes(32);
  const hmac_key = randomBytes(32);
  let destroyed = 0;

  const encrypt = (data: Buffer, storage_key: string): Buffer => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(storage_key, 'utf-8'));
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };

  const decrypt = (payload: Buffer, storage_key: string): Buffer => {
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12), {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(storage_key, 'utf-8'));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
  };

  const ctx = {
    tenant_id,
    storage: build_storage(bucket),
    encrypt,
    decrypt,
    create_cipher: () => {
      throw new Error('in_memory_tenant_context: streaming cipher is not supported');
    },
    create_decipher: () => {
      throw new Error('in_memory_tenant_context: streaming decipher is not supported');
    },
    create_content_hmac: (): Hmac => createHmac('sha256', hmac_key),
    destroy: () => {
      destroyed++;
    },
  } as unknown as TenantContext;

  return {
    ctx,
    keys: () => [...bucket.data.keys()].sort(),
    raw: (key: string): Buffer | undefined => bucket.data.get(key)?.body,
    set_raw: (key: string, data: Buffer): void => {
      bucket.data.set(key, { body: Buffer.from(data), etag: etag_of(data) });
    },
    remove: (key: string): void => {
      bucket.data.delete(key);
    },
    destroyed: () => destroyed,
  };
}
