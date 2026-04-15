import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { DefaultTenantContextFactory } from '@/adapters/tenant-context.factory';
import { S3_CLIENT_TOKEN } from '@/adapters/storage-s3/s3-client.factory';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import type { AtlasConfig } from '@/utils/config';

let mock_exists = false;
const mock_put = vi.fn().mockResolvedValue(undefined);
const mock_get = vi.fn();

vi.mock('@/adapters/storage-s3/s3-bucket-manager', () => ({
  ensure_bucket_exists: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/adapters/storage-s3/tenant-bucket-name', () => ({
  tenant_bucket_name: (id: string): string => `atlas-${id}`,
}));

vi.mock('@/adapters/storage-s3/s3-object-storage.adapter', () => ({
  S3ObjectStorage: class {
    exists = async (): Promise<boolean> => mock_exists;
    get = mock_get;
    put = mock_put;
  },
}));

describe('DefaultTenantContextFactory', () => {
  let container: Container;
  const config: AtlasConfig = {
    encryption_passphrase: 'unit-test-passphrase-32chars!!',
  } as AtlasConfig;

  beforeEach(() => {
    mock_exists = false;
    mock_put.mockClear();
    mock_get.mockReset();
    container = new Container();
    container.bind(S3_CLIENT_TOKEN).toConstantValue({});
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue(config);
    container.bind(DefaultTenantContextFactory).toSelf();
  });

  it('create_storage_only returns tenant_id and storage without touching DEK', async () => {
    const factory = container.get(DefaultTenantContextFactory);
    const ctx = await factory.create_storage_only('tenant-a');

    expect(ctx.tenant_id).toBe('tenant-a');
    expect(ctx.storage).toBeDefined();
    expect(mock_put).not.toHaveBeenCalled();
  });

  it('create generates and persists DEK when none exists', async () => {
    mock_exists = false;
    const factory = container.get(DefaultTenantContextFactory);
    const ctx = await factory.create('tenant-b');

    expect(mock_put).toHaveBeenCalledWith('_meta/dek.enc', expect.any(Buffer));
    const round = ctx.encrypt(Buffer.from('x'));
    expect(ctx.decrypt(round).toString()).toBe('x');
    ctx.destroy();
  });

  it('destroy zeros passphrase without breaking prior encrypt/decrypt', async () => {
    mock_exists = false;
    const factory = container.get(DefaultTenantContextFactory);
    const ctx = await factory.create('tenant-d');

    const ct = ctx.encrypt(Buffer.from('before'));
    ctx.destroy();
    expect(ctx.decrypt(ct).toString()).toBe('before');
  });

  it('create loads existing wrapped DEK when present', async () => {
    mock_exists = true;
    const ks = new EnvelopeKeyService(config.encryption_passphrase);
    const dek = ks.generate_dek();
    mock_get.mockResolvedValue(ks.wrap_dek(dek, 'tenant-c'));

    const factory = container.get(DefaultTenantContextFactory);
    const ctx = await factory.create('tenant-c');

    const ct = ctx.encrypt(Buffer.from('hello'));
    expect(ctx.decrypt(ct).toString()).toBe('hello');
  });
});
