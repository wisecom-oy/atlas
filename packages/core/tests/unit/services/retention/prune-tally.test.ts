import { describe, expect, it } from 'vitest';
import { ObjectLockRetainedError, type ObjectStorage } from '@wisecom/atlas-types';
import { in_memory_paged_version_storage } from '@wisecom/atlas-types/testing/in-memory-paged-version-storage';
import { in_memory_versioned_storage } from '@wisecom/atlas-types/testing/in-memory-versioned-storage';
import { PruneTally, settle_versions, versions_under } from '@/services/retention/prune-tally';
import { ReferencedKeySet } from '@/services/retention/referenced-key-set';

function paged_bucket() {
  return in_memory_paged_version_storage(in_memory_versioned_storage(), {
    page_size: 100,
    is_retention_refusal: (err) => err instanceof ObjectLockRetainedError,
  });
}

async function* unreferenced(storage: ObjectStorage, references: ReferencedKeySet) {
  for await (const version of versions_under(storage, 'data/')) {
    if (!references.has(version.key)) yield version;
  }
}

describe('settle_versions', () => {
  it('deletes only unreferenced versions across many listing pages, in batches', async () => {
    const bucket = paged_bucket();
    const references = new ReferencedKeySet();
    for (let i = 0; i < 2500; i++) {
      const key = `data/o/${String(i).padStart(5, '0')}`;
      await bucket.storage.put(key, Buffer.from('12345'));
      if (i % 2 === 0) references.add(key);
    }
    const tally = new PruneTally();

    await settle_versions(bucket.storage, unreferenced(bucket.storage, references), tally, false);

    expect(tally.counts.deleted_objects).toBe(1250);
    expect(tally.deleted_bytes).toBe(1250 * 5);
    expect((await bucket.storage.list('data/')).length).toBe(1250);
    expect(bucket.batch_calls.length).toBeGreaterThan(1);
    expect(bucket.peak_unsettled_entries()).toBeLessThan(2500);
  });

  it('counts what a dry run would delete and deletes nothing', async () => {
    const bucket = paged_bucket();
    await bucket.storage.put('data/o/a', Buffer.from('abc'));
    const tally = new PruneTally();

    await settle_versions(bucket.storage, versions_under(bucket.storage, 'data/'), tally, true);

    expect(tally.counts.deleted_objects).toBe(1);
    expect(tally.deleted_bytes).toBe(3);
    expect(await bucket.storage.exists('data/o/a')).toBe(true);
  });

  it('reports a version Object Lock retains as retained, not as failed', async () => {
    const bucket = paged_bucket();
    await bucket.storage.put('data/o/locked', Buffer.from('x'));
    bucket.lock(bucket.versions('data/o/locked')[0]!.version_id, new ObjectLockRetainedError('k'));
    const tally = new PruneTally();

    await settle_versions(bucket.storage, versions_under(bucket.storage, 'data/'), tally, false);

    expect(tally.counts.retained_objects).toBe(1);
    expect(tally.counts.failed_objects).toBe(0);
    expect(tally.deleted_bytes).toBe(0);
  });
});

describe('versions_under', () => {
  it('falls back to the visible keys on a backend that lists no versions', async () => {
    const storage = { list: async () => ['data/o/a'], list_versions: async () => [] };
    const listed = [];
    for await (const version of versions_under(storage, 'data/')) listed.push(version);
    expect(listed).toEqual([{ key: 'data/o/a' }]);
  });
});

describe('ReferencedKeySet', () => {
  it('answers for the keys it holds and ignores an absent key', () => {
    const references = new ReferencedKeySet();
    references.add('data/o/a');
    references.add(undefined);
    references.add('');
    expect(references.has('data/o/a')).toBe(true);
    expect(references.has('data/o/b')).toBe(false);
    expect(references.size).toBe(1);
  });
});
