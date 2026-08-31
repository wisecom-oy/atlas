import { BucketCache } from '@/adapters/bucket-cache';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensure_bucket_exists, probe_bucket_immutability } from '@/adapters/s3-bucket-manager';

function make_mock_s3(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

describe('s3-bucket-manager', () => {
  let mock_s3: ReturnType<typeof make_mock_s3>;
  let buckets: BucketCache;

  beforeEach(() => {
    mock_s3 = make_mock_s3();
    buckets = new BucketCache();
  });

  it('creates lock-capable buckets with housekeeping lifecycle rules (issue #30)', async () => {
    mock_s3.send
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotFound' }))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await ensure_bucket_exists(mock_s3 as never, 'new-bucket', buckets);

    expect(mock_s3.send).toHaveBeenCalledTimes(3);
    const create_cmd = mock_s3.send.mock.calls[1][0];
    expect(create_cmd.input.Bucket).toBe('new-bucket');
    expect(create_cmd.input.ObjectLockEnabledForBucket).toBe(true);
    const lifecycle_cmd = mock_s3.send.mock.calls[2][0];
    expect(lifecycle_cmd.input.Bucket).toBe('new-bucket');
    const rules = lifecycle_cmd.input.LifecycleConfiguration.Rules;
    expect(rules).toHaveLength(2);
    // Combined rule: MinIO rejects AbortIncompleteMultipartUpload as a sole action
    expect(rules[0].AbortIncompleteMultipartUpload).toEqual({ DaysAfterInitiation: 7 });
    expect(rules[0].Expiration?.ExpiredObjectDeleteMarker).toBe(true);
    expect(rules[1].NoncurrentVersionExpiration).toEqual({ NoncurrentDays: 30 });
  });

  it('falls back to a plain bucket when the backend rejects Object Lock at creation', async () => {
    mock_s3.send
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotFound' }))
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotImplemented' }))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await ensure_bucket_exists(mock_s3 as never, 'plain-bucket', buckets);

    expect(mock_s3.send).toHaveBeenCalledTimes(4);
    const retry_cmd = mock_s3.send.mock.calls[2][0];
    expect(retry_cmd.input.Bucket).toBe('plain-bucket');
    expect(retry_cmd.input.ObjectLockEnabledForBucket).toBeUndefined();
  });

  it('rethrows creation errors that are not a lock-capability rejection', async () => {
    mock_s3.send
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotFound' }))
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));

    await expect(ensure_bucket_exists(mock_s3 as never, 'forbidden', buckets)).rejects.toThrow(
      'denied',
    );
    expect(mock_s3.send).toHaveBeenCalledTimes(2);
  });

  it('swallows lifecycle errors on unsupported backends', async () => {
    mock_s3.send
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotFound' }))
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('NotImplemented'));

    await expect(
      ensure_bucket_exists(mock_s3 as never, 'no-lifecycle', buckets),
    ).resolves.toBeUndefined();
    expect(mock_s3.send).toHaveBeenCalledTimes(3);
  });

  it('skips creation when bucket already exists', async () => {
    mock_s3.send.mockResolvedValueOnce({});

    await ensure_bucket_exists(mock_s3 as never, 'existing', buckets);
    expect(mock_s3.send).toHaveBeenCalledTimes(1);
  });

  it('caches after first check and skips on second call', async () => {
    mock_s3.send.mockResolvedValueOnce({});

    await ensure_bucket_exists(mock_s3 as never, 'cached', buckets);
    await ensure_bucket_exists(mock_s3 as never, 'cached', buckets);

    expect(mock_s3.send).toHaveBeenCalledTimes(1);
  });

  it('rethrows unexpected errors from HeadBucket', async () => {
    mock_s3.send.mockRejectedValueOnce(new Error('AccessDenied'));

    await expect(ensure_bucket_exists(mock_s3 as never, 'x', buckets)).rejects.toThrow(
      'AccessDenied',
    );
  });

  it('probes versioning and object lock state', async () => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } });

    const result = await probe_bucket_immutability(mock_s3 as never, 'bucket-a', buckets, {
      mode: 'GOVERNANCE',
    });

    expect(result.bucket).toBe('bucket-a');
    expect(result.versioning_enabled).toBe(true);
    expect(result.object_lock_enabled).toBe(true);
    expect(result.mode_supported).toBe(true);
  });

  it('memoizes immutability probe by bucket and mode', async () => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } });

    await probe_bucket_immutability(mock_s3 as never, 'bucket-b', buckets, { mode: 'GOVERNANCE' });
    await probe_bucket_immutability(mock_s3 as never, 'bucket-b', buckets, { mode: 'GOVERNANCE' });

    expect(mock_s3.send).toHaveBeenCalledTimes(3);
  });

  it('returns not-ready probe result when bucket is missing', async () => {
    mock_s3.send.mockRejectedValueOnce(
      Object.assign(new Error('The specified bucket does not exist'), {
        name: 'Unknown',
        $metadata: { httpStatusCode: 404 },
      }),
    );

    const result = await probe_bucket_immutability(mock_s3 as never, 'missing-bucket', buckets, {
      mode: 'GOVERNANCE',
    });

    expect(result.reachable).toBe(true);
    expect(result.versioning_enabled).toBe(false);
    expect(result.object_lock_enabled).toBe(false);
    expect(result.mode_supported).toBe(false);
  });
});
