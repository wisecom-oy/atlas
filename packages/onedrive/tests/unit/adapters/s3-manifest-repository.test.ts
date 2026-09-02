import { describe, expect, it, vi } from 'vitest';
import type { OneDriveSnapshotManifest, TenantContext } from '@wisecom/atlas-types';
import { S3OneDriveManifestRepository } from '@/adapters/s3-onedrive-manifest-repository.adapter';

const OWNER = 'owner-1';
const OTHER_OWNER = 'owner-2';

function make_manifest(
  snapshot_id: string,
  created_at: string,
  owner_id = OWNER,
): OneDriveSnapshotManifest {
  return {
    id: `${owner_id}-${snapshot_id}`,
    tenant_id: 'tenant-1',
    owner_id,
    snapshot_id,
    created_at: new Date(created_at),
    total_files: 1,
    total_size_bytes: 10,
    entries: [],
  };
}

/** Storage stub holding plaintext JSON, matching the identity cipher below. */
function make_ctx(objects: Record<string, unknown> = {}, get_error: Record<string, Error> = {}) {
  const put = vi.fn(async (key: string, data: Buffer) => {
    objects[key] = JSON.parse(data.toString('utf-8'));
  });
  const ctx = {
    tenant_id: 'tenant-1',
    storage: {
      list: vi.fn(async (prefix: string) =>
        Object.keys(objects).filter((key) => key.startsWith(prefix)),
      ),
      get: vi.fn(async (key: string) => {
        const failure = get_error[key];
        if (failure) throw failure;
        const value = objects[key];
        return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf-8');
      }),
      put,
    },
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
    destroy: vi.fn(),
  } as unknown as TenantContext;
  return { ctx, put, objects };
}

describe('S3OneDriveManifestRepository', () => {
  const repo = new S3OneDriveManifestRepository();

  it('writes a manifest under the owner-scoped manifests prefix', async () => {
    const { ctx, objects } = make_ctx();

    await repo.save(ctx, make_manifest('snap-1', '2026-03-01T00:00:00Z'));

    expect(Object.keys(objects)).toEqual(['onedrive/manifests/owner-1/snap-1.json']);
  });

  it('lower-cases the owner segment so one owner never writes two prefixes', async () => {
    const { ctx, objects } = make_ctx();

    await repo.save(ctx, make_manifest('snap-1', '2026-03-01T00:00:00Z', 'Owner-1'));

    // Issue #38: S3 keys are case-sensitive, Entra object IDs are not.
    expect(Object.keys(objects)).toEqual(['onedrive/manifests/owner-1/snap-1.json']);
  });

  it('rejects a snapshot id that would escape the owner prefix', async () => {
    const { ctx } = make_ctx();

    await expect(
      repo.save(ctx, make_manifest('../../etc/passwd', '2026-03-01T00:00:00Z')),
    ).rejects.toThrow();
  });

  it('finds a manifest by snapshot id and revives created_at as a Date', async () => {
    const { ctx } = make_ctx({
      'onedrive/manifests/owner-1/snap-1.json': make_manifest('snap-1', '2026-03-01T00:00:00Z'),
    });

    const found = await repo.find_by_snapshot(ctx, OWNER, 'snap-1');

    expect(found?.snapshot_id).toBe('snap-1');
    // JSON round-trips a Date to a string, and the manifest chain sorts on
    // created_at.getTime(): a string here breaks snapshot ordering silently.
    expect(found?.created_at).toBeInstanceOf(Date);
    expect(found?.created_at.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('returns undefined for a snapshot id that is not stored', async () => {
    const { ctx } = make_ctx({
      'onedrive/manifests/owner-1/snap-1.json': make_manifest('snap-1', '2026-03-01T00:00:00Z'),
    });

    await expect(repo.find_by_snapshot(ctx, OWNER, 'snap-absent')).resolves.toBeUndefined();
  });

  it('does not return another owner\u2019s manifest with the same snapshot id', async () => {
    const { ctx } = make_ctx({
      'onedrive/manifests/owner-2/snap-1.json': make_manifest(
        'snap-1',
        '2026-03-01T00:00:00Z',
        OTHER_OWNER,
      ),
    });

    await expect(repo.find_by_snapshot(ctx, OWNER, 'snap-1')).resolves.toBeUndefined();
  });

  it('lists an owner\u2019s snapshots newest first', async () => {
    const { ctx } = make_ctx({
      'onedrive/manifests/owner-1/snap-old.json': make_manifest('snap-old', '2026-03-01T00:00:00Z'),
      'onedrive/manifests/owner-1/snap-new.json': make_manifest('snap-new', '2026-03-03T00:00:00Z'),
      'onedrive/manifests/owner-1/snap-mid.json': make_manifest('snap-mid', '2026-03-02T00:00:00Z'),
    });

    const listed = await repo.list_snapshots_by_owner(ctx, OWNER);

    expect(listed.map((m) => m.snapshot_id)).toEqual(['snap-new', 'snap-mid', 'snap-old']);
  });

  it('skips an unreadable object under the prefix instead of failing the listing', async () => {
    const { ctx } = make_ctx(
      {
        'onedrive/manifests/owner-1/snap-1.json': make_manifest('snap-1', '2026-03-01T00:00:00Z'),
        'onedrive/manifests/owner-1/snap-corrupt.json': 'not-json',
      },
      { 'onedrive/manifests/owner-1/snap-unreadable.json': new Error('decrypt failed') },
    );

    const listed = await repo.list_snapshots_by_owner(ctx, OWNER);

    // One bad object must not hide every other snapshot the owner has.
    expect(listed.map((m) => m.snapshot_id)).toEqual(['snap-1']);
  });

  it('throws when a manifest carries an unparseable created_at', async () => {
    const { ctx } = make_ctx({
      'onedrive/manifests/owner-1/snap-1.json': {
        ...make_manifest('snap-1', '2026-03-01T00:00:00Z'),
        created_at: 'not-a-date',
      },
    });

    // Distinct from a corrupt object: the manifest decrypted and parsed, so
    // skipping it would drop a real snapshot out of the chain.
    await expect(repo.list_snapshots_by_owner(ctx, OWNER)).rejects.toThrow(/Invalid created_at/);
  });

  it('returns the newest manifest as the latest for an owner', async () => {
    const { ctx } = make_ctx({
      'onedrive/manifests/owner-1/snap-old.json': make_manifest('snap-old', '2026-03-01T00:00:00Z'),
      'onedrive/manifests/owner-1/snap-new.json': make_manifest('snap-new', '2026-03-03T00:00:00Z'),
    });

    const latest = await repo.find_latest_by_owner(ctx, OWNER);

    expect(latest?.snapshot_id).toBe('snap-new');
  });

  it('reports no latest manifest for an owner that has never been backed up', async () => {
    const { ctx } = make_ctx();

    await expect(repo.find_latest_by_owner(ctx, OWNER)).resolves.toBeUndefined();
  });

  it('lists every owner\u2019s manifests from the root prefix, newest first', async () => {
    const { ctx } = make_ctx({
      'onedrive/manifests/owner-1/snap-a.json': make_manifest('snap-a', '2026-03-01T00:00:00Z'),
      'onedrive/manifests/owner-2/snap-b.json': make_manifest(
        'snap-b',
        '2026-03-02T00:00:00Z',
        OTHER_OWNER,
      ),
    });

    const all = await repo.list_all_manifests(ctx);

    expect(all.map((m) => m.snapshot_id)).toEqual(['snap-b', 'snap-a']);
  });

  it('reads only the owner prefix, never the whole manifests root', async () => {
    const { ctx } = make_ctx({
      'onedrive/manifests/owner-1/snap-1.json': make_manifest('snap-1', '2026-03-01T00:00:00Z'),
    });

    await repo.find_by_snapshot(ctx, OWNER, 'snap-1');

    // Issue #91: scanning the root prefix made snapshot lookup cost grow with
    // every other owner in the bucket.
    expect(ctx.storage.list).toHaveBeenCalledWith('onedrive/manifests/owner-1/');
  });
});
