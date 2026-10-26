import { describe, expect, it, vi } from 'vitest';
import { StorageError, UnreadableContentError } from '@wisecom/atlas-types';
import type { TenantContext } from '@wisecom/atlas-types';
import { S3IdentityRegistryRepository } from '@/adapters/s3-identity-registry-repository.adapter';

function make_ctx(body: string | undefined, get_error?: Error): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      exists: vi.fn(async () => body !== undefined),
      get: vi.fn(async () => {
        if (get_error) throw get_error;
        return Buffer.from(body ?? '', 'utf-8');
      }),
    },
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
  } as unknown as TenantContext;
}

describe('S3IdentityRegistryRepository.load', () => {
  const repo = new S3IdentityRegistryRepository();

  it('returns undefined when no registry exists', async () => {
    await expect(repo.load(make_ctx(undefined))).resolves.toBeUndefined();
  });

  it('returns the stored registry', async () => {
    const registry = { tenant_id: 'tenant-1', entries: [] };
    await expect(repo.load(make_ctx(JSON.stringify(registry)))).resolves.toEqual(registry);
  });

  it('raises StorageError when the registry exists and cannot be fetched', async () => {
    const ctx = make_ctx('{}', new Error('503 Slow Down'));
    await expect(repo.load(ctx)).rejects.toBeInstanceOf(StorageError);
  });

  it('raises UnreadableContentError when the registry fails to decrypt or parse', async () => {
    // Read as absent, the next registration would overwrite every entry (issue #438).
    await expect(repo.load(make_ctx('not-json'))).rejects.toBeInstanceOf(UnreadableContentError);
  });
});
