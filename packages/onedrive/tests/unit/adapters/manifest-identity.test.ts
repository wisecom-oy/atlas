import { describe, expect, it, vi } from 'vitest';
import type { OneDriveSnapshotManifest, TenantContext } from '@wisecom/atlas-types';
import { S3OneDriveManifestRepository } from '@/adapters/s3-onedrive-manifest-repository.adapter';

/**
 * Issue #340, mirrored from the SharePoint suite. A manifest is encrypted with the tenant key and
 * nothing in the ciphertext says which manifest it is, so any manifest in the tenant authenticates
 * at any other manifest's key.
 */

function make_manifest(owner_id: string, snapshot_id: string): OneDriveSnapshotManifest {
  return {
    id: `${owner_id}-${snapshot_id}`,
    tenant_id: 'tenant-1',
    owner_id,
    snapshot_id,
    created_at: new Date('2026-03-01T00:00:00Z'),
    total_files: 1,
    total_size_bytes: 10,
    entries: [],
  };
}

function make_ctx(objects: Record<string, unknown>): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      list: vi.fn(async (prefix: string) =>
        Object.keys(objects).filter((key) => key.startsWith(prefix)),
      ),
      get: vi.fn(async (key: string) => Buffer.from(JSON.stringify(objects[key]), 'utf-8')),
      put: vi.fn(),
    },
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

describe('OneDrive manifest identity (issue #340)', () => {
  const repo = new S3OneDriveManifestRepository();

  it('returns the manifest when the body is the identity its key names', async () => {
    const ctx = make_ctx({
      'onedrive/manifests/owner-a/snap-a.json': make_manifest('owner-a', 'snap-a'),
    });

    const found = await repo.find_by_snapshot(ctx, 'owner-a', 'snap-a');

    expect(found?.snapshot_id).toBe('snap-a');
  });

  it('refuses a manifest whose body names another owner and snapshot', async () => {
    const ctx = make_ctx({
      'onedrive/manifests/owner-a/snap-a.json': make_manifest('owner-b', 'snap-b'),
    });

    await expect(repo.find_by_snapshot(ctx, 'owner-a', 'snap-a')).rejects.toThrow(
      /decrypts to owner-b\/snap-b/,
    );
  });

  it('refuses the planted manifest through the listing path as well', async () => {
    const ctx = make_ctx({
      'onedrive/manifests/owner-a/snap-a.json': make_manifest('owner-b', 'snap-b'),
    });

    await expect(repo.list_snapshots_by_owner(ctx, 'owner-a')).rejects.toThrow(
      /refusing to use a manifest that is not the one the key names/,
    );
  });
});
