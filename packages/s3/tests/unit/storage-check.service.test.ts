import { BucketCache } from '@/adapters/bucket-cache';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { StorageCheckService } from '@/services/storage-check.service';
import { S3_CLIENT_TOKEN } from '@/adapters/s3-client.factory';

function make_mock_s3(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

describe('StorageCheckService', () => {
  let buckets: BucketCache;
  let mock_s3: ReturnType<typeof make_mock_s3>;
  let service: StorageCheckService;

  beforeEach(() => {
    mock_s3 = make_mock_s3();
    buckets = new BucketCache();
    const container = new Container();
    container.bind(S3_CLIENT_TOKEN).toConstantValue(mock_s3);
    container.bind(BucketCache).toConstantValue(buckets);
    container.bind(StorageCheckService).toSelf();
    service = container.get(StorageCheckService);
  });

  it('returns readiness details for Object Lock backup', async () => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } })
      .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } });

    const result = await service.check_storage('tenant-1', {
      mode: 'GOVERNANCE',
      retention_days: 30,
    });

    expect(result.bucket).toBe('atlas-tenant-1');
    expect(result.reachable).toBe(true);
    expect(result.versioning_enabled).toBe(true);
    expect(result.object_lock_enabled).toBe(true);
    expect(result.requested_mode).toBe('GOVERNANCE');
    expect(result.requested_retention_days).toBe(30);
    expect(result.resolved_retain_until).toBeDefined();
    expect(result.default_retention).toBeUndefined();
  });

  it('reports a bucket default retention on a lock-capable bucket', async () => {
    const lock_configuration = {
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 30 } },
      },
    };
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockResolvedValueOnce(lock_configuration)
      .mockResolvedValueOnce(lock_configuration);

    const result = await service.check_storage('tenant-1');

    expect(result.default_retention).toEqual({ mode: 'GOVERNANCE', days: 30 });
  });

  it('does not read a default retention when Object Lock is disabled', async () => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockRejectedValueOnce(new Error('ObjectLockConfigurationNotFoundError'));

    const result = await service.check_storage('tenant-1');

    expect(result.default_retention).toBeUndefined();
    expect(mock_s3.send).toHaveBeenCalledTimes(3);
  });
});
