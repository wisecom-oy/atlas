import { describe, it, expect, vi } from 'vitest';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { create_storage_target } from '@/adapters/storage-target.factory';
import type { StorageTargetConfig } from '@/ports/replication/storage-target.port';

const ks = new EnvelopeKeyService('test-pass', 'tenant-1');
const dek = ks.generate_dek();
const wrapped_dek = ks.wrap_dek(dek);

let mock_exists_returns = true;
vi.mock('@/adapters/storage-s3/s3-object-storage.adapter', () => ({
  S3ObjectStorage: class MockS3ObjectStorage {
    put = async (): Promise<void> => {};
    get = async (): Promise<Buffer> => wrapped_dek;
    delete = async (): Promise<void> => {};
    delete_version = async (): Promise<void> => {};
    exists = async (): Promise<boolean> => mock_exists_returns;
    list = async (): Promise<string[]> => [];
    list_versions = async (): Promise<string[]> => [];
    probe_immutability = async (): Promise<Record<string, unknown>> => ({});
  },
}));

vi.mock('@/adapters/storage-s3/s3-bucket-manager', () => ({
  ensure_bucket_exists: async (): Promise<void> => {},
}));

vi.mock('@/adapters/storage-s3/tenant-bucket-name', () => ({
  tenant_bucket_name: (id: string): string => `atlas-${id}`,
}));

describe('create_storage_target', () => {
  const base_config: StorageTargetConfig = {
    s3_endpoint: 'http://offsite:9000',
    s3_access_key: 'access',
    s3_secret_key: 'secret',
    encryption_passphrase: 'test-pass',
  };

  it('creates a storage target with auto-derived target_id', () => {
    const target = create_storage_target(base_config);

    expect(target.target_id).toBeTruthy();
    expect(target.target_id.length).toBe(16);
    expect(target.endpoint).toBe('http://offsite:9000');
  });

  it('uses explicit target_id when provided', () => {
    const target = create_storage_target({
      ...base_config,
      target_id: 'my-offsite',
    });

    expect(target.target_id).toBe('my-offsite');
  });

  it('creates a context with crypto when DEK exists', async () => {
    mock_exists_returns = true;
    const target = create_storage_target(base_config);
    const ctx = await target.create_context('tenant-1');

    expect(ctx.tenant_id).toBe('tenant-1');
    expect(ctx.storage).toBeDefined();
    expect(typeof ctx.encrypt).toBe('function');
    expect(typeof ctx.decrypt).toBe('function');
  });

  it('creates a storage-only context when no DEK exists', async () => {
    mock_exists_returns = false;
    const target = create_storage_target(base_config);
    const ctx = await target.create_context('tenant-1');

    expect(ctx.tenant_id).toBe('tenant-1');
    expect(ctx.storage).toBeDefined();
    expect(() => ctx.encrypt(Buffer.from('x'))).toThrow('no DEK');
    expect(() => ctx.decrypt(Buffer.from('x'))).toThrow('no DEK');
    mock_exists_returns = true;
  });

  it('derives same target_id for same endpoint + region', () => {
    const t1 = create_storage_target(base_config);
    const t2 = create_storage_target(base_config);
    expect(t1.target_id).toBe(t2.target_id);
  });

  it('derives different target_id for different endpoints', () => {
    const t1 = create_storage_target(base_config);
    const t2 = create_storage_target({
      ...base_config,
      s3_endpoint: 'http://other:9000',
    });
    expect(t1.target_id).not.toBe(t2.target_id);
  });
});
