import 'reflect-metadata';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Container } from 'inversify';
import { S3Client } from '@aws-sdk/client-s3';
import type { AtlasConfig, BucketSelection } from '@wisecom/atlas-core';
import {
  BUCKET_NAME_RESOLVER_TOKEN,
  STORAGE_CHECK_USE_CASE_TOKEN,
  STORAGE_INVENTORY_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  BucketNameResolver,
  StorageCheckUseCase,
  StorageInventoryFactory,
} from '@wisecom/atlas-types';
import { bind_s3_storage } from '@/container';

// The probe writes objects and has its own tests; here it would only add requests.
vi.mock('@/adapters/s3-conditional-write-probe', () => ({
  probe_conditional_writes: vi.fn(async () => ({ support: 'supported' })),
}));

// Issue #768: every S3 path in the container names the same bucket for the same tenant.

const TENANT = 'tid-prod';
const BASE = {
  tenant_id: TENANT,
  client_id: 'client',
  client_secret: '<redacted>',
  s3_endpoint: 'https://s3.example.invalid',
  s3_access_key: '<redacted>',
  s3_secret_key: '<redacted>',
  s3_region: 'us-east-1',
  encryption_passphrase: '<redacted>',
} satisfies AtlasConfig;
const OVERRIDE: BucketSelection = {
  run: { tenant_id: TENANT, bucket: 'prod-copy', exclusive: true, set_by: 'ATLAS_S3_BUCKET' },
  profiles: [],
};

function container_for(config: AtlasConfig): Container {
  const container = new Container();
  bind_s3_storage(container, config);
  return container;
}

/** Answers every request with an empty success and records the bucket each one named. */
function record_buckets(): () => string[] {
  const send = vi
    .spyOn(S3Client.prototype, 'send')
    .mockImplementation(async () => ({ IsTruncated: false }) as never);
  return () => send.mock.calls.map(([command]) => (command.input as { Bucket: string }).Bucket);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bind_s3_storage bucket naming (issue #768)', () => {
  it('derives atlas-<tenant_id> when no override is configured', () => {
    const resolver = container_for(BASE).get<BucketNameResolver>(BUCKET_NAME_RESOLVER_TOKEN);

    expect(resolver.resolve(TENANT)).toEqual({ name: `atlas-${TENANT}`, configured: false });
  });

  it('lists the configured bucket for stats storage', async () => {
    const buckets = record_buckets();
    const container = container_for({ ...BASE, s3_bucket: OVERRIDE });
    const open = container.get<StorageInventoryFactory>(STORAGE_INVENTORY_FACTORY_TOKEN);

    await open(TENANT).list_object_page({ prefix: '', mode: 'versions' });

    expect(buckets()).toEqual(['prod-copy']);
  });

  it('checks the configured bucket in checkStorage', async () => {
    const buckets = record_buckets();
    const container = container_for({ ...BASE, s3_bucket: OVERRIDE });
    const check = container.get<StorageCheckUseCase>(STORAGE_CHECK_USE_CASE_TOKEN);

    const result = await check.check_storage(TENANT);

    expect(result.bucket).toBe('prod-copy');
    expect(new Set(buckets())).toEqual(new Set(['prod-copy']));
  });
});
