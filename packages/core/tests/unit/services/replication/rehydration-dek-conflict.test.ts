import { describe, it, expect } from 'vitest';
import type { ObjectStorage } from '@wisecom/atlas-types';
import { StorageError } from '@wisecom/atlas-types';
import { ensure_source_dek_on_primary } from '@/services/replication/dek-rehydration-validator';
import { DekWriteConflictError } from '@/services/replication/conditional-dek-write';
import {
  in_memory_tenant_context,
  type InMemoryTenantContext,
} from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { stub_storage_target } from '@wisecom/atlas-types/testing/stub-storage-target';

// Issue #639: both primary DEK writes were plain puts, so a key another run stored between the
// checks and the write was silently replaced, and everything encrypted under it was lost.

const DEK_KEY = '_meta/dek.enc';
const SOURCE_DEK = Buffer.from('wrapped-source-dek');
const AUTO_DEK = Buffer.from('wrapped-auto-generated-dek');
const RIVAL_DEK = Buffer.from('wrapped-rival-dek');

/** Primary over a conditional-write-honouring bucket, with a hook that runs after one call. */
function primary_with_race(
  bucket: InMemoryTenantContext,
  after: 'exists' | 'list',
  concurrent_write: () => void,
): ObjectStorage {
  const inner = bucket.ctx.storage;
  return {
    ...inner,
    exists: async (key: string) => {
      const found = await inner.exists(key);
      if (after === 'exists') concurrent_write();
      return found;
    },
    list: async (prefix: string, limit?: number) => {
      const keys = await inner.list(prefix, limit);
      if (after === 'list') concurrent_write();
      return keys;
    },
  } as ObjectStorage;
}

function source_target(): ReturnType<typeof stub_storage_target>['target'] {
  return stub_storage_target({ objects: { [DEK_KEY]: SOURCE_DEK } }).target;
}

describe('ensure_source_dek_on_primary under a concurrent writer (issue #639)', () => {
  it('refuses when a rival key lands between the absence check and the create', async () => {
    const bucket = in_memory_tenant_context();
    const storage = primary_with_race(bucket, 'exists', () => bucket.set_raw(DEK_KEY, RIVAL_DEK));
    const primary = stub_storage_target({ storage }).target;

    const run = ensure_source_dek_on_primary(primary, source_target(), 't');

    await expect(run).rejects.toBeInstanceOf(DekWriteConflictError);
    await expect(run).rejects.toBeInstanceOf(StorageError);
    expect(bucket.raw(DEK_KEY)).toEqual(RIVAL_DEK);
  });

  it('accepts losing the create race to a run that stored the same source key', async () => {
    const bucket = in_memory_tenant_context();
    const storage = primary_with_race(bucket, 'exists', () => bucket.set_raw(DEK_KEY, SOURCE_DEK));
    const primary = stub_storage_target({ storage }).target;

    await ensure_source_dek_on_primary(primary, source_target(), 't');

    expect(bucket.raw(DEK_KEY)).toEqual(SOURCE_DEK);
  });

  it('refuses when the key changes between the emptiness check and the replacement', async () => {
    const bucket = in_memory_tenant_context();
    bucket.set_raw(DEK_KEY, AUTO_DEK);
    const storage = primary_with_race(bucket, 'list', () => bucket.set_raw(DEK_KEY, RIVAL_DEK));
    const primary = stub_storage_target({ storage }).target;

    await expect(
      ensure_source_dek_on_primary(primary, source_target(), 't'),
    ).rejects.toBeInstanceOf(DekWriteConflictError);

    expect(bucket.raw(DEK_KEY)).toEqual(RIVAL_DEK);
  });

  it('still replaces an auto-generated key nobody touched', async () => {
    const bucket = in_memory_tenant_context();
    bucket.set_raw(DEK_KEY, AUTO_DEK);
    const primary = stub_storage_target({ storage: bucket.ctx.storage }).target;

    await ensure_source_dek_on_primary(primary, source_target(), 't');

    expect(bucket.raw(DEK_KEY)).toEqual(SOURCE_DEK);
  });

  it('passes a write failure that is not a precondition through unchanged', async () => {
    const bucket = in_memory_tenant_context();
    const denied = new Error('AccessDenied');
    const storage = {
      ...bucket.ctx.storage,
      put: async () => {
        throw denied;
      },
    } as ObjectStorage;
    const primary = stub_storage_target({ storage }).target;

    await expect(ensure_source_dek_on_primary(primary, source_target(), 't')).rejects.toBe(denied);
  });
});
