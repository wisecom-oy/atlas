import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import type {
  ManifestRepository,
  OneDriveManifestRepository,
  SharePointManifestRepository,
  TeamsIndexRepository,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { StorageUsageService } from '@/services/stats/storage-usage.service';
import type { S3Config } from '@/utils/config';
import { fake_inventory, MIXED_BUCKET, type FakeInventory } from './storage-usage.fixtures';

// Issue #768: a copy of the tenant bucket under another name can sit on the same endpoint, so a
// continuation token names the bucket as well as the endpoint and region.

const TENANT = '00000000-0000-0000-0000-000000000000';

function service_on(bucket: string): { service: StorageUsageService; inventory: FakeInventory } {
  const inventory = fake_inventory(MIXED_BUCKET);
  const service = new StorageUsageService(
    () => inventory,
    {} as TenantContextFactory,
    {} as ManifestRepository,
    {} as OneDriveManifestRepository,
    {} as SharePointManifestRepository,
    {} as TeamsIndexRepository,
    { s3_endpoint: 'https://s3.primary.example', s3_region: 'us-east-1' } as S3Config,
    { resolve: () => ({ name: bucket, configured: bucket !== `atlas-${TENANT}` }) },
  );
  return { service, inventory };
}

describe('storage usage token and the bucket name (issue #768)', () => {
  it('refuses a token issued against another bucket on the same endpoint', async () => {
    const primary = service_on(`atlas-${TENANT}`);
    const { continuation_token } = await primary.service.measure_storage_usage(TENANT, {
      max_list_requests: 1,
    });
    const copy = service_on('tenant-copy');

    const resume = copy.service.measure_storage_usage(TENANT, { continuation_token });

    await expect(resume).rejects.toThrow(/different endpoint or bucket/);
    await expect(resume).rejects.toBeInstanceOf(ConfigError);
    expect(copy.inventory.requests()).toBe(0);
  });

  it('resumes a token on the bucket it was issued for', async () => {
    const first = service_on('tenant-copy');
    const { continuation_token } = await first.service.measure_storage_usage(TENANT, {
      max_list_requests: 1,
    });

    const resumed = await service_on('tenant-copy').service.measure_storage_usage(TENANT, {
      continuation_token,
      max_list_requests: 1,
    });

    expect(resumed.list_requests).toBeGreaterThan(0);
  });
});
