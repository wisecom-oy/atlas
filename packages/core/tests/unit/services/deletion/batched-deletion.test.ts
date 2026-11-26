/**
 * Issue #922: purge and owner delete stream the listing a page at a time and delete in batches.
 * Every test here walks more than one listing page.
 */
import { describe, it, expect, vi } from 'vitest';
import { ObjectLockRetainedError } from '@wisecom/atlas-types';
import type { ObjectStorage, StorageDeleteTarget } from '@wisecom/atlas-types';
import { in_memory_paged_version_storage } from '@wisecom/atlas-types/testing/in-memory-paged-version-storage';
import { in_memory_versioned_storage } from '@wisecom/atlas-types/testing/in-memory-versioned-storage';
import { delete_scopes } from '@/services/deletion/shared/prefix-deleter';
import {
  CONCURRENT_DELETE_BATCHES,
  DELETE_BATCH_SIZE,
} from '@/services/deletion/shared/version-batch-deleter';

const is_retention_refusal = (err: unknown): boolean => err instanceof ObjectLockRetainedError;

function paged_bucket(page_size: number, options: { without_delete_batch?: boolean } = {}) {
  return in_memory_paged_version_storage(in_memory_versioned_storage(), {
    page_size,
    is_retention_refusal,
    ...options,
  });
}

async function put_all(storage: ObjectStorage, keys: readonly string[]): Promise<void> {
  for (const key of keys) await storage.put(key, Buffer.from(key));
}

/** Swaps one optional storage method for a wrapper; the port marks them read-only. */
function replace_method<K extends 'delete_batch' | 'list_version_pages'>(
  storage: ObjectStorage,
  name: K,
  replacement: NonNullable<ObjectStorage[K]>,
): void {
  Object.assign(storage, { [name]: replacement });
}

function numbered(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(6, '0')}`);
}

describe('batched deletion', () => {
  it('holds a bounded number of entries however many versions the scope has', async () => {
    const bucket = paged_bucket(DELETE_BATCH_SIZE);
    await put_all(bucket.storage, numbered('data/u/', 20_000));

    const result = await delete_scopes(bucket.storage, ['data/u/']);

    expect(result.deleted_objects).toBe(20_000);
    expect(bucket.pages_listed()).toBe(20);
    // The batches in flight, the one being filled, and one listing page.
    expect(bucket.peak_unsettled_entries()).toBeLessThanOrEqual(
      (CONCURRENT_DELETE_BATCHES + 2) * DELETE_BATCH_SIZE,
    );
    expect(await bucket.storage.list_versions('data/u/')).toEqual([]);
  });

  it('sends at most the batch size per request and no single deletes when batches work', async () => {
    const bucket = paged_bucket(300);
    await put_all(bucket.storage, numbered('data/u/', 2_500));
    const single = vi.spyOn(bucket.storage, 'delete_version');

    const result = await delete_scopes(bucket.storage, ['data/u/']);

    expect(result.deleted_objects).toBe(2_500);
    expect(bucket.batch_calls.map((targets) => targets.length)).toEqual([1000, 1000, 500]);
    expect(single).not.toHaveBeenCalled();
  });

  it('keeps no more than the concurrency limit of batches in flight', async () => {
    const bucket = paged_bucket(DELETE_BATCH_SIZE);
    await put_all(bucket.storage, numbered('data/u/', 10_000));
    const batch = bucket.storage.delete_batch!;
    let in_flight = 0;
    let peak = 0;
    replace_method(
      bucket.storage,
      'delete_batch',
      async (targets: readonly StorageDeleteTarget[]) => {
        peak = Math.max(peak, ++in_flight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        try {
          return await batch(targets);
        } finally {
          in_flight--;
        }
      },
    );

    await delete_scopes(bucket.storage, ['data/u/']);

    expect(peak).toBe(CONCURRENT_DELETE_BATCHES);
  });

  it('deletes one version per request when the storage has no batch delete', async () => {
    const bucket = paged_bucket(2, { without_delete_batch: true });
    await put_all(bucket.storage, numbered('data/u/', 7));
    const single = vi.spyOn(bucket.storage, 'delete_version');

    const result = await delete_scopes(bucket.storage, ['data/u/']);

    expect(result.deleted_objects).toBe(7);
    expect(single).toHaveBeenCalledTimes(7);
    expect(bucket.pages_listed()).toBe(4);
  });

  it.each([
    ['in batches', {}],
    ['one at a time', { without_delete_batch: true }],
  ])('splits locked and failed versions the same way %s', async (_label, options) => {
    const bucket = paged_bucket(3, options);
    await put_all(bucket.storage, [...numbered('data/u/', 9), ...numbered('manifests/u/', 4)]);
    const version_of = (key: string) => bucket.versions(key)[0]!.version_id;
    for (const key of ['data/u/000001', 'data/u/000007', 'manifests/u/000002']) {
      bucket.lock(version_of(key), new ObjectLockRetainedError(key));
    }
    // A missing IAM permission is a failure, never a retention.
    bucket.lock(version_of('data/u/000004'), new Error('AccessDenied: Access Denied'));

    const result = await delete_scopes(bucket.storage, ['']);

    expect(result).toEqual({
      deleted_objects: 6,
      deleted_manifests: 3,
      retained_objects: 2,
      retained_manifests: 1,
      failed_objects: 1,
      failed_manifests: 0,
    });
  });

  it('erases every manifest root before any data, across many pages', async () => {
    const bucket = paged_bucket(2);
    // Bucket order lists attachments and data long before the manifest roots.
    await put_all(bucket.storage, [
      ...numbered('attachments/u/', 3),
      ...numbered('data/u/', 3),
      ...numbered('manifests/u/', 3),
      ...numbered('onedrive/data/u/', 3),
      ...numbered('onedrive/manifests/u/', 3),
      ...numbered('_quarantine/calendar/manifests/u/', 2),
    ]);

    const result = await delete_scopes(bucket.storage, ['']);

    const order = bucket.batch_calls.flatMap((targets) => targets.map((t) => t.key));
    const is_manifest = order.map((key) => key.includes('manifests/'));
    expect(order).toHaveLength(17);
    expect(is_manifest).toEqual([
      ...Array<boolean>(8).fill(true),
      ...Array<boolean>(9).fill(false),
    ]);
    expect(result.deleted_manifests).toBe(8);
    expect(result.deleted_objects).toBe(9);
  });

  it('counts a retained manifest once, though both passes list it', async () => {
    const bucket = paged_bucket(2);
    await put_all(bucket.storage, [...numbered('manifests/u/', 3), ...numbered('data/u/', 3)]);
    const locked = bucket.versions('manifests/u/000001')[0]!.version_id;
    bucket.lock(locked, new ObjectLockRetainedError('manifests/u/000001'));

    const result = await delete_scopes(bucket.storage, ['']);

    expect(result.retained_manifests).toBe(1);
    expect(result.deleted_manifests).toBe(2);
    expect(result.deleted_objects).toBe(3);
  });

  it('removes delete markers across pages without counting them as data', async () => {
    const bucket = paged_bucket(2);
    await put_all(bucket.storage, numbered('data/u/', 3));
    const listed = await bucket.storage.list_versions('data/u/');
    const pages = bucket.storage.list_version_pages!.bind(bucket.storage);
    replace_method(bucket.storage, 'list_version_pages', async function* (prefix: string) {
      for await (const page of pages(prefix)) {
        yield page.map((version) =>
          version.key === listed[0]!.key ? { ...version, is_delete_marker: true } : version,
        );
      }
    });

    const result = await delete_scopes(bucket.storage, ['data/u/']);

    expect(result.deleted_objects).toBe(2);
    expect(await bucket.storage.list_versions('data/u/')).toEqual([]);
  });

  it('counts a batch whose request failed as failed and carries on with the rest', async () => {
    const bucket = paged_bucket(DELETE_BATCH_SIZE);
    await put_all(bucket.storage, numbered('data/u/', 2_500));
    const batch = bucket.storage.delete_batch!;
    let calls = 0;
    replace_method(
      bucket.storage,
      'delete_batch',
      async (targets: readonly StorageDeleteTarget[]) => {
        if (++calls === 2) throw new Error('socket hang up');
        return batch(targets);
      },
    );

    const result = await delete_scopes(bucket.storage, ['data/u/']);

    expect(result.failed_objects).toBe(1000);
    expect(result.deleted_objects).toBe(1500);
  });

  it('propagates a listing failure once the batches already sent have settled', async () => {
    const bucket = paged_bucket(DELETE_BATCH_SIZE);
    await put_all(bucket.storage, numbered('data/u/', 3_000));
    const pages = bucket.storage.list_version_pages!.bind(bucket.storage);
    replace_method(bucket.storage, 'list_version_pages', async function* (prefix: string) {
      let page_number = 0;
      for await (const page of pages(prefix)) {
        if (++page_number === 3) throw new Error('listing refused');
        yield page;
      }
    });

    await expect(delete_scopes(bucket.storage, ['data/u/'])).rejects.toThrow('listing refused');
    expect(await bucket.storage.list_versions('data/u/')).toHaveLength(1000);
  });
});
