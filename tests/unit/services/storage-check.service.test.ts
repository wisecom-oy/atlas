import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { StorageCheckService } from '@/services/storage-check/storage-check.service';
import { S3_CLIENT_TOKEN } from '@/adapters/storage-s3/s3-client.factory';
import { reset_bucket_cache } from '@/adapters/storage-s3/s3-bucket-manager';

function make_mock_s3(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

describe('StorageCheckService', () => {
  let mock_s3: ReturnType<typeof make_mock_s3>;
  let service: StorageCheckService;

  beforeEach(() => {
    mock_s3 = make_mock_s3();
    reset_bucket_cache();
    const container = new Container();
    container.bind(S3_CLIENT_TOKEN).toConstantValue(mock_s3);
    container.bind(StorageCheckService).toSelf();
    service = container.get(StorageCheckService);
  });

  it('returns readiness details for Object Lock backup', async () => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
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
  });
});
