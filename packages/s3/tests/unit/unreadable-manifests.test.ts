import { describe, expect, it, vi } from 'vitest';
import type { Manifest } from '@wisecom/atlas-types';
import { StorageError, UnreadableObjectsError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3ManifestRepository } from '@/adapters/s3-manifest-repository.adapter';

const OWNER = '00000000-0000-0000-0000-00000000abcd';

function manifest(snapshot_id: string, created_at: string): Manifest {
  return {
    id: `id-${snapshot_id}`,
    tenant_id: 'tenant-1',
    owner_id: OWNER,
    snapshot_id,
    created_at: new Date(created_at),
    total_objects: 1,
    total_size_bytes: 1,
    delta_links: {},
    entries: [],
  };
}

/** Two Outlook snapshots, the newer (which the latest pointer names) damaged by one byte. */
async function newest_damaged() {
  const harness = in_memory_tenant_context();
  const repo = new S3ManifestRepository();
  await repo.save(harness.ctx, manifest('snap-old', '2026-03-01T00:00:00Z'));
  await repo.save(harness.ctx, manifest('snap-new', '2026-03-02T00:00:00Z'));
  const damaged_key = `manifests/${OWNER}/snap-new.json`;
  const bytes = Buffer.from(harness.raw(damaged_key)!);
  bytes[bytes.length - 3]! ^= 0x10;
  harness.set_raw(damaged_key, bytes);
  return { harness, repo, damaged_key };
}

describe('S3ManifestRepository with a damaged manifest (issue #631)', () => {
  it('lists the readable manifests and names the damaged key', async () => {
    const { harness, repo, damaged_key } = await newest_damaged();

    const listing = await repo.list_readable_by_owner(harness.ctx, OWNER);

    expect(listing.manifests.map((m) => m.snapshot_id)).toEqual(['snap-old']);
    expect(listing.unreadable_keys).toEqual([damaged_key]);
  });

  it('lists every readable manifest in the tenant and names the damaged key', async () => {
    const { harness, repo, damaged_key } = await newest_damaged();

    const listing = await repo.list_all_readable(harness.ctx);

    expect(listing.manifests.map((m) => m.snapshot_id)).toEqual(['snap-old']);
    expect(listing.unreadable_keys).toEqual([damaged_key]);
  });

  it('falls back from a damaged pointer target to the newest readable manifest', async () => {
    const { harness, repo, damaged_key } = await newest_damaged();

    const latest = await repo.find_latest_readable(harness.ctx, OWNER);

    expect(latest.manifest?.snapshot_id).toBe('snap-old');
    expect(latest.unreadable_keys).toEqual([damaged_key]);
  });

  it('keeps the strict listing a chain reads refusing, with the key named', async () => {
    const { harness, repo, damaged_key } = await newest_damaged();

    const read = repo.list_by_owner(harness.ctx, OWNER);

    await expect(read).rejects.toBeInstanceOf(UnreadableObjectsError);
    await expect(read).rejects.toMatchObject({ unreadable_keys: [damaged_key] });
  });

  it('refuses the damaged snapshot by id and by key', async () => {
    const { harness, repo, damaged_key } = await newest_damaged();

    await expect(repo.find_by_snapshot(harness.ctx, 'snap-new')).rejects.toMatchObject({
      unreadable_keys: [damaged_key],
    });
    await expect(repo.read_manifest_at(harness.ctx, damaged_key)).rejects.toMatchObject({
      code: 'ATLAS_CONTENT_UNREADABLE',
    });
  });

  it('reads the latest through its pointer alone when it is healthy', async () => {
    const harness = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(harness.ctx, manifest('snap-old', '2026-03-01T00:00:00Z'));
    await repo.save(harness.ctx, manifest('snap-new', '2026-03-02T00:00:00Z'));

    const latest = await repo.find_latest_readable(harness.ctx, OWNER);

    expect(latest).toMatchObject({ manifest: { snapshot_id: 'snap-new' }, unreadable_keys: [] });
  });

  it('fails the latest read on a transient pointer error instead of scanning for damage', async () => {
    const { harness, repo } = await newest_damaged();
    const get = harness.ctx.storage.get;
    const list = vi.fn(harness.ctx.storage.list);
    harness.ctx.storage.list = list;
    harness.ctx.storage.get = async (key) => {
      if (key.endsWith('/latest.json')) throw new Error('connection reset');
      return get(key);
    };

    await expect(repo.find_latest_readable(harness.ctx, OWNER)).rejects.toBeInstanceOf(
      StorageError,
    );
    expect(list).not.toHaveBeenCalled();
  });
});
