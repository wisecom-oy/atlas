import { describe, it, expect, vi } from 'vitest';
import { create_storage_target } from '@/adapters/storage-target.factory';
import { EnvelopeKeyService } from '@atlas/core';
import type { StorageTargetConfig } from '@atlas/types';

// Holder the hoisted mock can close over; populated by the crypto test before use.
const crypto_state = vi.hoisted(() => ({ wrapped_dek: Buffer.alloc(0) }));

let mock_exists_returns = true;
vi.mock('@/adapters/s3-object-storage.adapter', () => ({
  S3ObjectStorage: class MockS3ObjectStorage {
    put = async (): Promise<void> => {};
    get = async (key: string): Promise<Buffer> => {
      if (key === '_meta/dek.enc') return crypto_state.wrapped_dek;
      throw new Error(`unexpected get(${key})`);
    };
    delete = async (): Promise<void> => {};
    delete_version = async (): Promise<void> => {};
    exists = async (): Promise<boolean> => mock_exists_returns;
    list = async (): Promise<string[]> => [];
    list_versions = async (): Promise<string[]> => [];
    begin_multipart_upload = async () => ({
      upload_part: async (): Promise<string> => '',
      complete: async (): Promise<void> => {},
      abort: async (): Promise<void> => {},
    });
    copy = async (): Promise<void> => {};
    abort_incomplete_uploads = async (): Promise<number> => 0;
    probe_immutability = async (): Promise<Record<string, unknown>> => ({});
  },
}));

vi.mock('@/adapters/s3-bucket-manager', () => ({
  ensure_bucket_exists: async (): Promise<void> => {},
}));

vi.mock('@/adapters/tenant-bucket-name', () => ({
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

  it('creates a context with working crypto when DEK exists', async () => {
    const svc = new EnvelopeKeyService('test-pass');
    const dek = svc.generate_dek();
    crypto_state.wrapped_dek = svc.wrap_dek(dek, 'tenant-1');
    mock_exists_returns = true;

    const target = create_storage_target(base_config);
    const ctx = await target.create_context('tenant-1');

    expect(ctx.tenant_id).toBe('tenant-1');
    expect(ctx.storage).toBeDefined();
    // Round-trip proves unwrap_dek recovered the original DEK.
    const plaintext = Buffer.from('round-trip');
    expect(ctx.decrypt(ctx.encrypt(plaintext)).equals(plaintext)).toBe(true);
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
