import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ensure_bucket_exists,
  probe_bucket_immutability,
  reset_bucket_cache,
} from '@/adapters/storage-s3/s3-bucket-manager';

function make_mock_s3(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

describe('s3-bucket-manager', () => {
  let mock_s3: ReturnType<typeof make_mock_s3>;

  beforeEach(() => {
    mock_s3 = make_mock_s3();
    reset_bucket_cache();
  });

  it('creates bucket with housekeeping lifecycle rules when it does not exist', async () => {
    mock_s3.send
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotFound' }))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await ensure_bucket_exists(mock_s3 as never, 'new-bucket');

    expect(mock_s3.send).toHaveBeenCalledTimes(3);
    const create_cmd = mock_s3.send.mock.calls[1][0];
    expect(create_cmd.input.Bucket).toBe('new-bucket');
    const lifecycle_cmd = mock_s3.send.mock.calls[2][0];
    expect(lifecycle_cmd.input.Bucket).toBe('new-bucket');
    const rules = lifecycle_cmd.input.LifecycleConfiguration.Rules;
    expect(rules).toHaveLength(2);
    expect(rules[0].AbortIncompleteMultipartUpload).toEqual({ DaysAfterInitiation: 7 });
    expect(rules[0].NoncurrentVersionExpiration).toBeUndefined();
    expect(rules[1].ExpiredObjectDeleteMarker).toBe(true);
  });

  it('swallows lifecycle errors on unsupported backends', async () => {
    mock_s3.send
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotFound' }))
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('NotImplemented'));

    await expect(ensure_bucket_exists(mock_s3 as never, 'no-lifecycle')).resolves.toBeUndefined();
    expect(mock_s3.send).toHaveBeenCalledTimes(3);
  });

  it('skips creation when bucket already exists', async () => {
    mock_s3.send.mockResolvedValueOnce({});

    await ensure_bucket_exists(mock_s3 as never, 'existing');
    expect(mock_s3.send).toHaveBeenCalledTimes(1);
  });

  it('caches after first check and skips on second call', async () => {
    mock_s3.send.mockResolvedValueOnce({});

    await ensure_bucket_exists(mock_s3 as never, 'cached');
    await ensure_bucket_exists(mock_s3 as never, 'cached');

    expect(mock_s3.send).toHaveBeenCalledTimes(1);
  });

  it('rethrows unexpected errors from HeadBucket', async () => {
    mock_s3.send.mockRejectedValueOnce(new Error('AccessDenied'));

    await expect(ensure_bucket_exists(mock_s3 as never, 'x')).rejects.toThrow('AccessDenied');
  });

  it('probes versioning and object lock state', async () => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } });

    const result = await probe_bucket_immutability(mock_s3 as never, 'bucket-a', {
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

    await probe_bucket_immutability(mock_s3 as never, 'bucket-b', { mode: 'GOVERNANCE' });
    await probe_bucket_immutability(mock_s3 as never, 'bucket-b', { mode: 'GOVERNANCE' });

    expect(mock_s3.send).toHaveBeenCalledTimes(3);
  });

  it('returns not-ready probe result when bucket is missing', async () => {
    mock_s3.send.mockRejectedValueOnce(
      Object.assign(new Error('The specified bucket does not exist'), {
        name: 'Unknown',
        $metadata: { httpStatusCode: 404 },
      }),
    );

    const result = await probe_bucket_immutability(mock_s3 as never, 'missing-bucket', {
      mode: 'GOVERNANCE',
    });

    expect(result.reachable).toBe(true);
    expect(result.versioning_enabled).toBe(false);
    expect(result.object_lock_enabled).toBe(false);
    expect(result.mode_supported).toBe(false);
  });
});
