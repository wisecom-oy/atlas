import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validate_dek_match, DekMismatchError } from '@/adapters/dek-validator';
import { EnvelopeKeyService } from '@atlas/core';
import type { ObjectStorage } from '@atlas/types';

function make_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn(),
    list: vi.fn(),
    list_versions: vi.fn(),
    begin_multipart_upload: vi.fn().mockResolvedValue({
      upload_part: vi.fn(),
      complete: vi.fn(),
      abort: vi.fn(),
    }),
    copy: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
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
    const key_service = await EnvelopeKeyService.create(passphrase, tenant_id);
    const dek = key_service.generate_dek();
    const wrapped = key_service.wrap_dek(dek);

    vi.mocked(target_storage.exists).mockImplementation(async (key: string) =>
      key === '_meta/dek.enc' ? true : false,
    );
    for (const s of [source_storage, target_storage]) {
      vi.mocked(s.exists).mockImplementation(async (key: string) =>
        key === '_meta/dek.enc' ? true : false,
      );
      vi.mocked(s.get).mockImplementation(async (key: string) => {
        if (key === '_meta/dek.enc') return wrapped;
        throw new Error(`unexpected get(${key})`);
      });
    }

    await expect(
      validate_dek_match(source_storage, target_storage, passphrase, tenant_id),
    ).resolves.toBeUndefined();
  });

  it('throws DekMismatchError when DEKs differ', async () => {
    const key_service = await EnvelopeKeyService.create(passphrase, tenant_id);
    const dek_a = key_service.generate_dek();
    const dek_b = key_service.generate_dek();
    const wrapped_a = key_service.wrap_dek(dek_a);
    const wrapped_b = key_service.wrap_dek(dek_b);

    for (const [s, wrapped] of [
      [source_storage, wrapped_a],
      [target_storage, wrapped_b],
    ] as const) {
      vi.mocked(s.exists).mockImplementation(async (key: string) =>
        key === '_meta/dek.enc' ? true : false,
      );
      vi.mocked(s.get).mockImplementation(async (key: string) => {
        if (key === '_meta/dek.enc') return wrapped;
        throw new Error(`unexpected get(${key})`);
      });
    }

    await expect(
      validate_dek_match(source_storage, target_storage, passphrase, tenant_id),
    ).rejects.toThrow(DekMismatchError);
  });
});
