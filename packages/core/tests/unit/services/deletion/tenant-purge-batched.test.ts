/**
 * Issue #922: a tenant purge and an owner delete over a paged listing and batched deletes keep
 * their ordering: manifests before data, the DEK after everything it protects, the lease last.
 */
import { describe, it, expect } from 'vitest';
import { ObjectLockRetainedError } from '@wisecom/atlas-types';
import type { ObjectStorage } from '@wisecom/atlas-types';
import { in_memory_paged_version_storage } from '@wisecom/atlas-types/testing/in-memory-paged-version-storage';
import { in_memory_versioned_storage } from '@wisecom/atlas-types/testing/in-memory-versioned-storage';
import { stub_held_owner_lease } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { DEK_KEY, sweep_tenant_bucket } from '@/services/deletion/shared/tenant-purge-sweep';
import { erase_leased_owner_scopes } from '@/services/deletion/shared/leased-owner-deletion';

const LEASE = stub_held_owner_lease();

function paged_bucket() {
  return in_memory_paged_version_storage(in_memory_versioned_storage(), {
    page_size: 2,
    is_retention_refusal: (err) => err instanceof ObjectLockRetainedError,
  });
}

async function put_all(storage: ObjectStorage, keys: readonly string[]): Promise<void> {
  for (const key of keys) await storage.put(key, Buffer.from(key));
}

const TENANT_KEYS = [
  '_meta/dek.enc',
  '_meta/replica.marker',
  'attachments/u/a1',
  'data/u/d1',
  'data/u/d2',
  'identity-registry.json',
  'manifests/u/snap-1.json',
  'onedrive/data/u/blob',
  'onedrive/manifests/u/snap-1.json',
  LEASE.storage_key,
];

describe('batched tenant purge and owner delete', () => {
  it('deletes manifests first and the DEK and lease last', async () => {
    const bucket = paged_bucket();
    await put_all(bucket.storage, TENANT_KEYS);

    const result = await sweep_tenant_bucket(bucket.storage, LEASE);

    const order = bucket.batch_calls.flatMap((targets) => targets.map((t) => t.key));
    expect(order.slice(0, 2)).toEqual([
      'manifests/u/snap-1.json',
      'onedrive/manifests/u/snap-1.json',
    ]);
    expect(order.slice(-2)).toEqual([DEK_KEY, LEASE.storage_key]);
    expect(order).toHaveLength(TENANT_KEYS.length);
    expect(result.deleted_manifests).toBe(2);
    // Everything but the lease, which is not backup data.
    expect(result.deleted_objects).toBe(7);
    expect(await bucket.storage.list_versions('')).toEqual([]);
  });

  it('keeps the DEK while a locked version survives the sweep', async () => {
    const bucket = paged_bucket();
    await put_all(bucket.storage, TENANT_KEYS);
    const locked = bucket.versions('onedrive/data/u/blob')[0]!.version_id;
    bucket.lock(locked, new ObjectLockRetainedError('onedrive/data/u/blob'));

    const result = await sweep_tenant_bucket(bucket.storage, LEASE);

    expect(result.retained_objects).toBe(1);
    expect(result.failed_objects).toBe(0);
    const left = (await bucket.storage.list_versions('')).map((version) => version.key);
    expect(left.sort()).toEqual([DEK_KEY, 'onedrive/data/u/blob']);
  });

  it('erases an owner across pages and its lease last', async () => {
    const bucket = paged_bucket();
    const lease = { ...LEASE, storage_key: 'onedrive/_meta/u/lease.json' };
    await put_all(bucket.storage, [
      'onedrive/data/u/b1',
      'onedrive/data/u/b2',
      'onedrive/data/u/b3',
      'onedrive/manifests/u/s1.json',
      'onedrive/manifests/u/s2.json',
      'onedrive/manifests/u/s3.json',
      'onedrive/_meta/u/cursor.json',
      lease.storage_key,
    ]);

    const result = await erase_leased_owner_scopes(bucket.storage, lease, [
      'onedrive/manifests/u/',
      'onedrive/data/u/',
      'onedrive/_meta/u/',
    ]);

    const order = bucket.batch_calls.flatMap((targets) => targets.map((t) => t.key));
    expect(order.slice(0, 3).every((key) => key.startsWith('onedrive/manifests/u/'))).toBe(true);
    expect(order.at(-1)).toBe(lease.storage_key);
    expect(result.deleted_manifests).toBe(3);
    expect(result.deleted_objects).toBe(4);
    expect(bucket.pages_listed()).toBeGreaterThan(3);
  });
});
