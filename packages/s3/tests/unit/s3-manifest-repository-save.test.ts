import { describe, expect, it, vi } from 'vitest';
import type { Manifest } from '@wisecom/atlas-types';
import { RefusedWriteError, StoredObjectConflictError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3ManifestRepository } from '@/adapters/s3-manifest-repository.adapter';

const MANIFEST_KEY = 'manifests/user@test.com/snap-1.json';
const SNAPSHOT_POINTER_KEY = '_meta/outlook-manifests/snapshots/snap-1.json';
const LATEST_POINTER_KEY = '_meta/outlook-manifests/owners/user@test.com/latest.json';
const SUMMARY_KEY = '_meta/outlook-manifests/owners/user@test.com/summary.json';

function make_manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date('2026-01-15T10:00:00Z'),
    total_objects: 1,
    total_size_bytes: 512,
    delta_links: { folder1: 'https://delta/link' },
    entries: [
      {
        object_id: 'msg-1',
        storage_key: 'data/user@test.com/abc',
        checksum: 'abc',
        size_bytes: 512,
      },
    ],
    ...overrides,
  };
}

describe('S3ManifestRepository.save', () => {
  it('stores the manifest, its encrypted lookup pointers, then its summary row', async () => {
    const mem = in_memory_tenant_context();
    const encrypt = vi.spyOn(mem.ctx, 'encrypt');
    const put = vi.spyOn(mem.ctx.storage, 'put');

    await new S3ManifestRepository().save(mem.ctx, make_manifest());

    // Manifest, snapshot pointer, latest pointer, summary: the two pointers carry the same JSON
    // but live in different directories, and each is bound to its own (issue #350).
    expect(encrypt).toHaveBeenCalledTimes(4);
    expect(put.mock.calls.map((call) => call[0])).toEqual([
      MANIFEST_KEY,
      SNAPSHOT_POINTER_KEY,
      LATEST_POINTER_KEY,
      SUMMARY_KEY,
    ]);
  });

  it('creates the summary only onto an absent key and does not read it back', async () => {
    const mem = in_memory_tenant_context();
    const put = vi.spyOn(mem.ctx.storage, 'put');
    const get = vi.spyOn(mem.ctx.storage, 'get');

    await new S3ManifestRepository().save(mem.ctx, make_manifest());

    const summary_put = put.mock.calls.find((call) => call[0] === SUMMARY_KEY);
    expect(summary_put?.slice(4)).toEqual([undefined, true]);
    expect(get.mock.calls).not.toContainEqual([SUMMARY_KEY]);
  });

  it('applies effective object lock policy to manifest uploads', async () => {
    const mem = in_memory_tenant_context();
    const put = vi.spyOn(mem.ctx.storage, 'put');
    const manifest = make_manifest({
      object_lock: {
        requested: { mode: 'GOVERNANCE', retention_days: 30 },
        effective: { mode: 'GOVERNANCE', retain_until: '2026-04-08T12:00:00.000Z' },
      },
    });

    await new S3ManifestRepository().save(mem.ctx, manifest);

    expect(put.mock.calls[0]![3]).toEqual({
      mode: 'GOVERNANCE',
      retain_until: '2026-04-08T12:00:00.000Z',
    });
  });

  it('writes the manifest create-only, reads it back once, and reads the latest pointer once', async () => {
    const mem = in_memory_tenant_context();
    const put = vi.spyOn(mem.ctx.storage, 'put');
    const get = vi.spyOn(mem.ctx.storage, 'get');

    await new S3ManifestRepository().save(mem.ctx, make_manifest());

    expect(put.mock.calls[0]![5]).toBe(true);
    expect(get.mock.calls).toEqual([[MANIFEST_KEY], [LATEST_POINTER_KEY]]);
  });

  it('overwrites the latest pointer when the owner gets a newer snapshot', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(mem.ctx, make_manifest());

    await repo.save(
      mem.ctx,
      make_manifest({ snapshot_id: 'snap-2', created_at: new Date('2026-02-01T00:00:00Z') }),
    );

    const latest = await repo.find_latest_readable(mem.ctx, 'user@test.com');
    expect(latest.manifest?.snapshot_id).toBe('snap-2');
  });

  it('returns created_at as a Date after a save round trip', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    const manifest = make_manifest();
    await repo.save(mem.ctx, manifest);

    const found = await repo.find_by_snapshot(mem.ctx, 'snap-1');

    expect(found?.created_at).toBeInstanceOf(Date);
    expect(found?.created_at.getTime()).toBe(manifest.created_at.getTime());
  });

  it('refuses a manifest its own reader would call damaged and writes nothing', async () => {
    const mem = in_memory_tenant_context();
    const malformed = make_manifest({ entries: undefined as unknown as Manifest['entries'] });

    const save = new S3ManifestRepository().save(mem.ctx, malformed);

    await expect(save).rejects.toBeInstanceOf(RefusedWriteError);
    await expect(save).rejects.toThrow(MANIFEST_KEY);
    await expect(save).rejects.toThrow('Nothing was written');
    expect(mem.keys()).toEqual([]);
  });

  it('refuses a manifest with an unparseable created_at and writes nothing', async () => {
    const mem = in_memory_tenant_context();
    const malformed = make_manifest({ created_at: new Date(Number.NaN) });

    await expect(new S3ManifestRepository().save(mem.ctx, malformed)).rejects.toBeInstanceOf(
      RefusedWriteError,
    );
    expect(mem.keys()).toEqual([]);
  });

  it('never replaces a manifest already stored under the snapshot id', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(mem.ctx, make_manifest());
    const first = Buffer.from(mem.raw(MANIFEST_KEY)!);

    const colliding = repo.save(mem.ctx, make_manifest({ total_objects: 99, entries: [] }));

    await expect(colliding).rejects.toBeInstanceOf(StoredObjectConflictError);
    expect(mem.raw(MANIFEST_KEY)!.equals(first)).toBe(true);
  });

  it('leaves the summary untouched when the guarded manifest save fails', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(mem.ctx, make_manifest());
    const summary = Buffer.from(mem.raw(SUMMARY_KEY)!);

    await expect(repo.save(mem.ctx, make_manifest({ entries: [] }))).rejects.toBeInstanceOf(
      StoredObjectConflictError,
    );

    expect(mem.raw(SUMMARY_KEY)!.equals(summary)).toBe(true);
  });
});
