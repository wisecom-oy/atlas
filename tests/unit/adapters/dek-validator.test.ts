import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validate_dek_match, DekMismatchError } from '@/adapters/storage-s3/dek-validator';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';

function make_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn(),
    list: vi.fn(),
    list_versions: vi.fn(),
    probe_immutability: vi.fn(),
  };
}

describe('validate_dek_match', () => {
  const passphrase = 'test-passphrase';
  const tenant_id = 'tenant-1';
  let source_storage: ObjectStorage;
  let target_storage: ObjectStorage;

  beforeEach(() => {
    source_storage = make_storage();
    target_storage = make_storage();
  });

  it('passes when target has no dek.enc', async () => {
    vi.mocked(target_storage.exists).mockResolvedValue(false);

    await expect(
      validate_dek_match(source_storage, target_storage, passphrase, tenant_id),
    ).resolves.toBeUndefined();

    expect(source_storage.get).not.toHaveBeenCalled();
  });

  it('passes when both sides have the same DEK', async () => {
    const key_service = new EnvelopeKeyService(passphrase, tenant_id);
    const dek = key_service.generate_dek();
    const wrapped = key_service.wrap_dek(dek);

    vi.mocked(target_storage.exists).mockResolvedValue(true);
    vi.mocked(source_storage.get).mockResolvedValue(wrapped);
    vi.mocked(target_storage.get).mockResolvedValue(wrapped);

    await expect(
      validate_dek_match(source_storage, target_storage, passphrase, tenant_id),
    ).resolves.toBeUndefined();
  });

  it('throws DekMismatchError when DEKs differ', async () => {
    const key_service = new EnvelopeKeyService(passphrase, tenant_id);
    const dek_a = key_service.generate_dek();
    const dek_b = key_service.generate_dek();
    const wrapped_a = key_service.wrap_dek(dek_a);
    const wrapped_b = key_service.wrap_dek(dek_b);

    vi.mocked(target_storage.exists).mockResolvedValue(true);
    vi.mocked(source_storage.get).mockResolvedValue(wrapped_a);
    vi.mocked(target_storage.get).mockResolvedValue(wrapped_b);

    await expect(
      validate_dek_match(source_storage, target_storage, passphrase, tenant_id),
    ).rejects.toThrow(DekMismatchError);
  });
});
