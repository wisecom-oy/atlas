/**
 * Issue #915 at the adapter: a conditional put on a backend that does not enforce conditional
 * writes is refused before it is sent, and the probe behind it runs once per bucket and process.
 */
import { describe, expect, it } from 'vitest';
import { BucketCache } from '@/adapters/bucket-cache';
import { ConditionalWritesNotEnforcedError } from '@/adapters/conditional-write.errors';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import { CEPH_18, ENFORCING, IGNORING, fake_conditional_s3 } from './fake-conditional-s3';

const BUCKET = 'test-bucket';
const LEASE_KEY = '_meta/leases/outlook/owner-1.json';

function storage_over(s3: { send: unknown }, cache = new BucketCache()): S3ObjectStorage {
  return new S3ObjectStorage(s3 as never, BUCKET, cache);
}

describe('S3ObjectStorage conditional-write guard (issue #915)', () => {
  it('writes create-only on an enforcing backend, after one probe it cleans up', async () => {
    const s3 = fake_conditional_s3(ENFORCING);

    await storage_over(s3).put(
      LEASE_KEY,
      Buffer.from('lease'),
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(s3.probes_started()).toBe(1);
    expect([...s3.objects.keys()]).toEqual([LEASE_KEY]);
  });

  it('refuses a create-only write on a backend that ignores conditions, before sending it', async () => {
    const s3 = fake_conditional_s3(IGNORING);

    const refusal = storage_over(s3).put(
      LEASE_KEY,
      Buffer.from('lease'),
      undefined,
      undefined,
      undefined,
      true,
    );

    await expect(refusal).rejects.toMatchObject({
      name: 'ConditionalWritesNotEnforcedError',
      violations: ['create_only', 'stale_if_match'],
    });
    expect(s3.put_keys()).not.toContain(LEASE_KEY);
    expect(s3.objects.size).toBe(0);
  });

  it('refuses a compare-and-swap on Ceph RGW 18, which refuses the current ETag', async () => {
    const s3 = fake_conditional_s3(CEPH_18);

    await expect(
      storage_over(s3).put(LEASE_KEY, Buffer.from('lease'), undefined, undefined, '"etag"'),
    ).rejects.toMatchObject({ violations: ['create_only', 'current_if_match'] });
    expect(s3.put_keys()).not.toContain(LEASE_KEY);
  });

  it('never probes for an unconditional write', async () => {
    const s3 = fake_conditional_s3(IGNORING);

    await storage_over(s3).put('content/blob', Buffer.from('data'));

    expect(s3.probes_started()).toBe(0);
  });

  it('probes once for every storage over the same cache, including concurrent writes', async () => {
    const s3 = fake_conditional_s3(ENFORCING);
    const cache = new BucketCache();
    const writes = ['a', 'b', 'c'].map((owner) =>
      storage_over(s3, cache).put(
        `_meta/leases/outlook/${owner}.json`,
        Buffer.from(owner),
        undefined,
        undefined,
        undefined,
        true,
      ),
    );

    await Promise.all(writes);
    await storage_over(s3, cache).put(
      '_meta/leases/outlook/d.json',
      Buffer.from('d'),
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(s3.probes_started()).toBe(1);
  });

  it('lets the write through when the bucket does not exist yet, so the write reports it', async () => {
    const s3 = fake_conditional_s3(ENFORCING);
    s3.send.mockImplementation(async () => {
      throw Object.assign(new Error('NoSuchBucket'), { name: 'NoSuchBucket' });
    });

    await expect(
      storage_over(s3).put(LEASE_KEY, Buffer.from('lease'), undefined, undefined, undefined, true),
    ).rejects.toMatchObject({ name: 'NoSuchBucket' });
    expect(s3.put_keys()).toContain(LEASE_KEY);
  });

  it('runs a fresh probe for storage-check every time, and reports instead of refusing', async () => {
    const s3 = fake_conditional_s3(IGNORING);
    const storage = storage_over(s3);

    const first = await storage.check_conditional_writes();
    await storage.check_conditional_writes();

    expect(first.support).toBe('ignored');
    expect(s3.probes_started()).toBe(2);
    expect(s3.objects.size).toBe(0);
  });

  it('is exported as a typed error', () => {
    expect(new ConditionalWritesNotEnforcedError(BUCKET, ['create_only'], 'x').code).toBe(
      'ATLAS_CONFIG_INVALID',
    );
  });
});
