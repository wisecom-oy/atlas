import { describe, expect, it, vi } from 'vitest';
import type { SharePointSnapshotManifest, TenantContext } from '@wisecom/atlas-types';
import { S3SharePointManifestRepository } from '@/adapters/s3-sharepoint-manifest-repository.adapter';

/**
 * Issue #340: a manifest is encrypted with the tenant key and nothing in the ciphertext says which
 * manifest it is, so any manifest in the tenant authenticates at any other manifest's key. Someone
 * with write access to the bucket and no key can move one under another's name.
 */

function make_manifest(site_id: string, snapshot_id: string): SharePointSnapshotManifest {
  return {
    id: `${site_id}-${snapshot_id}`,
    tenant_id: 'tenant-1',
    site_id,
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

describe('SharePoint manifest identity (issue #340)', () => {
  const repo = new S3SharePointManifestRepository();

  it('returns the manifest when the body is the identity its key names', async () => {
    const ctx = make_ctx({
      'sharepoint/manifests/site-a/snap-a.json': make_manifest('site-a', 'snap-a'),
    });

    const found = await repo.find_by_snapshot(ctx, 'site-a', 'snap-a');

    expect(found?.snapshot_id).toBe('snap-a');
  });

  it('refuses a manifest whose body names another site and snapshot', async () => {
    // Valid ciphertext for this tenant, planted at another snapshot's key.
    const ctx = make_ctx({
      'sharepoint/manifests/site-a/snap-a.json': make_manifest('site-b', 'snap-b'),
    });

    await expect(repo.find_by_snapshot(ctx, 'site-a', 'snap-a')).rejects.toThrow(
      /decrypts to site-b\/snap-b/,
    );
  });

  it('refuses the planted manifest through the listing path as well', async () => {
    const ctx = make_ctx({
      'sharepoint/manifests/site-a/snap-a.json': make_manifest('site-b', 'snap-b'),
    });

    // A silent skip here would leave `find_latest_by_site` reporting the site as never backed up.
    await expect(repo.list_snapshots_by_site(ctx, 'site-a')).rejects.toThrow(
      /refusing to use a manifest that is not the one the key names/,
    );
  });
});
