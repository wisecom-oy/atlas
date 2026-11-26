/**
 * Issue #974 at the adapter, on a backend whose `HeadObject` carries no `ETag`: checked writes must
 * not read the missing ETag as a changed object and refuse every compare-and-swap.
 */
import { describe, expect, it } from 'vitest';
import { BucketCache } from '@/adapters/bucket-cache';
import { ConditionalWritePolicy } from '@/adapters/conditional-write-policy';
import { PreconditionFailedError } from '@/adapters/object-lock.errors';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import { IGNORING, etag_of, fake_conditional_s3 } from './fake-conditional-s3';

const BUCKET = 'test-bucket';
const KEY = '_meta/identity-registry.json';
const HEAD_WITHOUT_ETAG = { ...IGNORING, head_omits_etag: true };

function opt_in_storage(s3: { send: unknown }): S3ObjectStorage {
  return new S3ObjectStorage(
    s3 as never,
    BUCKET,
    new BucketCache(),
    new ConditionalWritePolicy('single_writer'),
  );
}

describe('checked conditions when HEAD reports no ETag (issue #974)', () => {
  it('accepts a compare-and-swap on the current ETag', async () => {
    const s3 = fake_conditional_s3(HEAD_WITHOUT_ETAG);
    s3.objects.set(KEY, Buffer.from('v1'));

    await opt_in_storage(s3).put(
      KEY,
      Buffer.from('v2'),
      undefined,
      undefined,
      etag_of(Buffer.from('v1')),
    );

    expect(s3.objects.get(KEY)?.toString()).toBe('v2');
  });

  it('still refuses a compare-and-swap on a stale ETag', async () => {
    const s3 = fake_conditional_s3(HEAD_WITHOUT_ETAG);
    s3.objects.set(KEY, Buffer.from('v2'));

    await expect(
      opt_in_storage(s3).put(
        KEY,
        Buffer.from('v3'),
        undefined,
        undefined,
        etag_of(Buffer.from('v1')),
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(s3.objects.get(KEY)?.toString()).toBe('v2');
  });

  it('accepts a create-only write onto an absent key', async () => {
    const s3 = fake_conditional_s3(HEAD_WITHOUT_ETAG);

    await opt_in_storage(s3).put(KEY, Buffer.from('first'), undefined, undefined, undefined, true);

    expect(s3.objects.get(KEY)?.toString()).toBe('first');
  });

  it('still reports a lost race by comparing the stored bytes', async () => {
    const s3 = fake_conditional_s3(HEAD_WITHOUT_ETAG);
    s3.overwrite_after_next_put(Buffer.from('other process'));

    await expect(
      opt_in_storage(s3).put(KEY, Buffer.from('mine'), undefined, undefined, undefined, true),
    ).rejects.toThrow(/another writer replaced the object right after this write/);
  });
});
