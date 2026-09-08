import { describe, it, expect, vi } from 'vitest';
import { S3ManifestRepository } from '@/adapters/s3-manifest-repository.adapter';
import type { Manifest, TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stub_tenant_create_decipher } from '@wisecom/atlas-types/testing/stub-tenant-create-decipher';

/**
 * Issue #340: a manifest is encrypted with the tenant key and nothing in the ciphertext says which
 * manifest it is, so any manifest in the tenant authenticates at any other manifest's key. The
 * pointer lookups already compared the id they had; the legacy scan and the listings did not.
 */

function make_manifest(owner_id: string, snapshot_id: string): Manifest {
  return {
    id: `${owner_id}-${snapshot_id}`,
    tenant_id: 'test-tenant',
    owner_id,
    snapshot_id,
    created_at: new Date('2026-01-15T10:00:00Z'),
    total_objects: 0,
    total_size_bytes: 0,
    delta_links: {},
    entries: [],
  };
}

function make_ctx(objects: Record<string, Manifest>): TenantContext {
  return {
    tenant_id: 'test-tenant',
    storage: {
      put: vi.fn(),
      get: vi.fn(async (key: string) => {
        const value = objects[key];
        if (!value) throw new Error(`missing ${key}`);
        return Buffer.concat([Buffer.from('ENC:'), Buffer.from(JSON.stringify(value))]);
      }),
      list: vi.fn(async (prefix: string) =>
        Object.keys(objects).filter((key) => key.startsWith(prefix)),
      ),
      delete: vi.fn(),
      delete_version: vi.fn(),
      exists: vi.fn(),
      list_versions: vi.fn().mockResolvedValue([]),
      begin_multipart_upload: vi.fn(),
      copy: vi.fn(),
      get_with_etag: vi.fn(),
      get_stream: vi.fn(),
      apply_default_retention: vi.fn(),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
      probe_immutability: vi.fn(),
    },
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('ENC:'), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(4)),
    create_cipher: stub_tenant_create_cipher,
    create_decipher: stub_tenant_create_decipher,
    destroy: vi.fn(),
  };
}

describe('Outlook manifest identity (issue #340)', () => {
  const repo = new S3ManifestRepository();

  it('returns the manifest when the body is the identity its key names', async () => {
    const ctx = make_ctx({
      'manifests/user@test.com/snap-1.json': make_manifest('user@test.com', 'snap-1'),
    });

    const found = await repo.find_by_snapshot(ctx, 'snap-1');

    expect(found?.snapshot_id).toBe('snap-1');
  });

  it('refuses a manifest whose body names another owner and snapshot', async () => {
    // Valid ciphertext for this tenant, planted at another snapshot's key. No pointer object
    // exists, so this is the legacy scan path that had no identity check at all.
    const ctx = make_ctx({
      'manifests/user@test.com/snap-1.json': make_manifest('other@test.com', 'snap-2'),
    });

    await expect(repo.find_by_snapshot(ctx, 'snap-1')).rejects.toThrow(
      /decrypts to other@test.com\/snap-2/,
    );
  });

  it('refuses the planted manifest through the listing path as well', async () => {
    const ctx = make_ctx({
      'manifests/user@test.com/snap-1.json': make_manifest('other@test.com', 'snap-2'),
    });

    await expect(repo.list_all_manifests(ctx)).rejects.toThrow(
      /refusing to use a manifest that is not the one the key names/,
    );
  });
});
