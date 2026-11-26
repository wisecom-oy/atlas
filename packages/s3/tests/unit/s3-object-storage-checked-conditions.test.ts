/**
 * Issue #974 at the adapter: in an opt-in writer-exclusion mode, create-only and compare-and-swap
 * writes keep their meaning on a backend that ignores the conditions and on one that rejects them,
 * because Atlas checks the condition itself and never sends the header.
 */
import { describe, expect, it } from 'vitest';
import { BucketCache } from '@/adapters/bucket-cache';
import { ConditionalWritePolicy } from '@/adapters/conditional-write-policy';
import { PreconditionFailedError } from '@/adapters/object-lock.errors';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import {
  IGNORING,
  REJECTING,
  etag_of,
  fake_conditional_s3,
  type ConditionalBehaviour,
} from './fake-conditional-s3';

const BUCKET = 'test-bucket';
const KEY = 'outlook/manifests/owner-1/snap-1.json';

function opt_in_storage(
  s3: { send: unknown },
  policy = new ConditionalWritePolicy('single_writer'),
): S3ObjectStorage {
  return new S3ObjectStorage(s3 as never, BUCKET, new BucketCache(), policy);
}

function create_only(storage: S3ObjectStorage, body: string): Promise<void> {
  return storage.put(KEY, Buffer.from(body), undefined, undefined, undefined, true);
}

function compare_and_swap(storage: S3ObjectStorage, body: string, etag: string): Promise<void> {
  return storage.put(KEY, Buffer.from(body), undefined, undefined, etag);
}

const BACKENDS: ReadonlyArray<[string, ConditionalBehaviour]> = [
  ['ignores the conditions', IGNORING],
  ['rejects the conditions with 501', REJECTING],
];

describe.each(BACKENDS)('checked conditions on a backend that %s (issue #974)', (_name, kind) => {
  it('writes a create-only object onto an absent key without sending a condition or probing', async () => {
    const s3 = fake_conditional_s3(kind);

    await create_only(opt_in_storage(s3), 'first');

    expect(s3.objects.get(KEY)?.toString()).toBe('first');
    expect(s3.conditional_puts()).toBe(0);
    expect(s3.probes_started()).toBe(0);
  });

  it('refuses a create-only write onto an existing object and leaves it unchanged', async () => {
    const s3 = fake_conditional_s3(kind);
    s3.objects.set(KEY, Buffer.from('stored'));

    await expect(create_only(opt_in_storage(s3), 'second')).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    expect(s3.objects.get(KEY)?.toString()).toBe('stored');
  });

  it('accepts a compare-and-swap on the current ETag and refuses one on a stale ETag', async () => {
    const s3 = fake_conditional_s3(kind);
    const storage = opt_in_storage(s3);
    s3.objects.set(KEY, Buffer.from('v1'));
    const stale = etag_of(Buffer.from('v1'));

    await compare_and_swap(storage, 'v2', stale);
    await expect(compare_and_swap(storage, 'v3', stale)).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );

    expect(s3.objects.get(KEY)?.toString()).toBe('v2');
    expect(s3.conditional_puts()).toBe(0);
  });

  it('refuses a compare-and-swap on a key that no longer exists', async () => {
    const s3 = fake_conditional_s3(kind);

    await expect(compare_and_swap(opt_in_storage(s3), 'v1', '"gone"')).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    expect(s3.objects.has(KEY)).toBe(false);
  });

  it('lets exactly one of several concurrent create-only writes in one process win', async () => {
    const s3 = fake_conditional_s3(kind);
    const policy = new ConditionalWritePolicy('host_exclusion');
    const writes = ['a', 'b', 'c', 'd'].map((body) =>
      create_only(opt_in_storage(s3, policy), body).then(
        () => 'won',
        (err: unknown) => (err instanceof PreconditionFailedError ? 'refused' : 'failed'),
      ),
    );

    const outcomes = await Promise.all(writes);

    expect(outcomes.filter((outcome) => outcome === 'won')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'refused')).toHaveLength(3);
  });

  it('reports a lost race when another writer replaces the object right after the write', async () => {
    const s3 = fake_conditional_s3(kind);
    s3.overwrite_after_next_put(Buffer.from('other process'));

    await expect(create_only(opt_in_storage(s3), 'mine')).rejects.toThrow(
      /another writer replaced the object right after this write/,
    );
  });

  it('sends unconditional writes unchanged', async () => {
    const s3 = fake_conditional_s3(kind);

    await opt_in_storage(s3).put('content/blob', Buffer.from('data'));

    expect(s3.objects.get('content/blob')?.toString()).toBe('data');
    expect(s3.send.mock.calls.map(([cmd]) => cmd.constructor.name)).toEqual(['PutObjectCommand']);
  });
});

describe('the default mode is unchanged (issue #974)', () => {
  it('still sends the condition, so a backend that rejects it fails the write', async () => {
    const s3 = fake_conditional_s3(REJECTING);
    const storage = new S3ObjectStorage(s3 as never, BUCKET, new BucketCache());

    await expect(create_only(storage, 'first')).rejects.toMatchObject({ name: 'NotImplemented' });
    expect(s3.probes_started()).toBe(1);
    expect(s3.objects.has(KEY)).toBe(false);
  });

  it('still refuses a backend that ignores the conditions', async () => {
    const s3 = fake_conditional_s3(IGNORING);
    const storage = new S3ObjectStorage(s3 as never, BUCKET, new BucketCache());

    await expect(create_only(storage, 'first')).rejects.toMatchObject({
      name: 'ConditionalWritesNotEnforcedError',
    });
    expect(s3.objects.has(KEY)).toBe(false);
  });
});
