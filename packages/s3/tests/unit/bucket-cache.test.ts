import { describe, expect, it, vi } from 'vitest';
import { BucketCache } from '@/adapters/bucket-cache';
import { ensure_bucket_exists, probe_bucket_immutability } from '@/adapters/s3-bucket-manager';

function make_mock_s3() {
  return { send: vi.fn() };
}

describe('BucketCache', () => {
  it('remembers a checked bucket', () => {
    const cache = new BucketCache();

    expect(cache.is_bucket_checked('b')).toBe(false);
    cache.mark_bucket_checked('b');
    expect(cache.is_bucket_checked('b')).toBe(true);
  });

  it('keys probes by the requested mode, since each answers one question', () => {
    const cache = new BucketCache();
    const result = {
      bucket: 'b',
      reachable: true,
      versioning_enabled: true,
      object_lock_enabled: true,
      mode_supported: true,
    };

    cache.set_immutability_probe('b', 'GOVERNANCE', result);

    expect(cache.get_immutability_probe('b', 'GOVERNANCE')).toBe(result);
    expect(cache.get_immutability_probe('b', 'COMPLIANCE')).toBeUndefined();
    expect(cache.get_immutability_probe('b', undefined)).toBeUndefined();
  });

  it('forgets everything on clear', () => {
    const cache = new BucketCache();
    cache.mark_bucket_checked('b');
    cache.set_immutability_probe('b', undefined, {
      bucket: 'b',
      reachable: true,
      versioning_enabled: false,
      object_lock_enabled: false,
      mode_supported: false,
    });

    cache.clear();

    expect(cache.is_bucket_checked('b')).toBe(false);
    expect(cache.get_immutability_probe('b', undefined)).toBeUndefined();
  });
});

describe('cache isolation between instances (issue #42)', () => {
  it('does not let one instance skip bucket creation because another checked the name', async () => {
    const first_endpoint = make_mock_s3();
    const second_endpoint = make_mock_s3();
    const first_cache = new BucketCache();
    const second_cache = new BucketCache();

    // The bucket exists at the first endpoint.
    first_endpoint.send.mockResolvedValue({});
    await ensure_bucket_exists(first_endpoint as never, 'atlas-tenant', first_cache);

    // The same name at the second endpoint does not exist yet, so it is created.
    second_endpoint.send
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotFound' }))
      .mockResolvedValue({});
    await ensure_bucket_exists(second_endpoint as never, 'atlas-tenant', second_cache);

    // Before instance-scoped caches this second call returned immediately and
    // the bucket was never created, with writes failing later.
    expect(second_endpoint.send).toHaveBeenCalled();
    expect(second_cache.is_bucket_checked('atlas-tenant')).toBe(true);
  });

  it('does not let one instance read another endpoint\u2019s Object Lock capability', async () => {
    const locked = make_mock_s3();
    const plain = make_mock_s3();
    const locked_cache = new BucketCache();
    const plain_cache = new BucketCache();

    locked.send
      .mockResolvedValueOnce({}) // HeadBucket
      .mockResolvedValueOnce({ Status: 'Enabled' }) // versioning
      .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } });
    const locked_probe = await probe_bucket_immutability(
      locked as never,
      'atlas-tenant',
      locked_cache,
      { mode: 'GOVERNANCE' },
    );

    plain.send
      .mockResolvedValueOnce({}) // HeadBucket
      .mockResolvedValueOnce({}) // versioning disabled
      .mockRejectedValueOnce(
        Object.assign(new Error(), { name: 'ObjectLockConfigurationNotFoundError' }),
      );
    const plain_probe = await probe_bucket_immutability(
      plain as never,
      'atlas-tenant',
      plain_cache,
      { mode: 'GOVERNANCE' },
    );

    // Same bucket name, different endpoints, different truth. A shared cache
    // handed the second caller the first one's answer.
    expect(locked_probe.object_lock_enabled).toBe(true);
    expect(plain_probe.object_lock_enabled).toBe(false);
  });

  it('still memoizes within one instance', async () => {
    const s3 = make_mock_s3();
    const cache = new BucketCache();
    s3.send.mockResolvedValue({});

    await ensure_bucket_exists(s3 as never, 'atlas-tenant', cache);
    const calls_after_first = s3.send.mock.calls.length;
    await ensure_bucket_exists(s3 as never, 'atlas-tenant', cache);

    // The point of the cache survives the move out of module scope.
    expect(s3.send.mock.calls.length).toBe(calls_after_first);
  });

  it('re-checks when the caller asks to skip the cache', async () => {
    const s3 = make_mock_s3();
    const cache = new BucketCache();
    s3.send.mockResolvedValue({});

    await ensure_bucket_exists(s3 as never, 'atlas-tenant', cache);
    const calls_after_first = s3.send.mock.calls.length;
    await ensure_bucket_exists(s3 as never, 'atlas-tenant', cache, true);

    // Replication targets pass this: a target bucket can be deleted between runs.
    expect(s3.send.mock.calls.length).toBeGreaterThan(calls_after_first);
  });
});
