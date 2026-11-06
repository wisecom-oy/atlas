import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type {
  TeamsGraphResource,
  TeamsMessageRef,
  TeamsStoredBlobRef,
  TenantContext,
} from '@wisecom/atlas-types';
import type { StubEncryptedObjectStore } from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';

export const TEAM = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab';
export const TIMESTAMP = '2025-01-01T00:00:00.000Z';

/**
 * Seals `plaintext` into `bucket` and returns the blob reference a message or index would
 * record.
 */
export function put_blob(
  bucket: Map<string, Buffer>,
  store: StubEncryptedObjectStore,
  storage_key: string,
  plaintext: string,
): TeamsStoredBlobRef {
  const bytes = Buffer.from(plaintext, 'utf-8');
  bucket.set(storage_key, store.encrypt(bytes));
  return {
    storage_key,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length,
  };
}

/** Seals a Graph message resource as the blob a message ref points at. */
export function put_message(
  bucket: Map<string, Buffer>,
  store: StubEncryptedObjectStore,
  storage_key: string,
  content: TeamsGraphResource,
): TeamsStoredBlobRef {
  return put_blob(bucket, store, storage_key, JSON.stringify(content));
}

/** Builds a message ref for a stored blob with no hosted contents. */
export function message_ref(
  own: TeamsStoredBlobRef,
  extra: Partial<TeamsMessageRef> = {},
): TeamsMessageRef {
  return { ...own, last_modified_at: TIMESTAMP, hosted: {}, ...extra };
}

/** Builds a read-only tenant context whose storage reads the in-memory bucket. */
export function stub_save_context(
  store: StubEncryptedObjectStore,
  bucket: Map<string, Buffer>,
): TenantContext {
  const get = vi.fn(async (key: string) => {
    const body = bucket.get(key);
    if (body === undefined) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    return body;
  });
  return {
    storage: { exists: vi.fn(async (key: string) => bucket.has(key)), get },
    decrypt: (payload: Buffer) => store.decrypt(payload),
    create_content_hmac: () => stub_tenant_create_content_hmac(),
    destroy: vi.fn(),
  } as unknown as TenantContext;
}
