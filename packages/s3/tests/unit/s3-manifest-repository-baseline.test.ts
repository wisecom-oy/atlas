import { describe, expect, it, vi } from 'vitest';
import type { Manifest } from '@wisecom/atlas-types';
import { RefusedWriteError, StoredObjectConflictError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { stub_held_owner_lease } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { S3ManifestRepository } from '@/adapters/s3-manifest-repository.adapter';

const OWNER = 'user@test.com';
const MANIFEST_KEY = `manifests/${OWNER}/snap-1.json`;

function make_manifest(entries: string[], overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: OWNER,
    snapshot_id: 'snap-1',
    created_at: new Date('2026-01-15T10:00:00Z'),
    total_objects: entries.length,
    total_size_bytes: 512,
    delta_links: {},
    entries: entries.map((object_id) => ({
      object_id,
      storage_key: `data/${OWNER}/${object_id}`,
      checksum: object_id,
      size_bytes: 1,
    })),
    ...overrides,
  };
}

describe('S3ManifestRepository.replace_with_baseline (#977)', () => {
  it('replaces the stored manifest, which save refuses, and rewrites its summary row', async () => {
    const mem = in_memory_tenant_context();
    const repository = new S3ManifestRepository();
    await repository.save(mem.ctx, make_manifest(['m1']));
    await expect(repository.save(mem.ctx, make_manifest(['m1', 'm2']))).rejects.toBeInstanceOf(
      StoredObjectConflictError,
    );

    await repository.replace_with_baseline(
      mem.ctx,
      make_manifest(['m1', 'm2']),
      stub_held_owner_lease(),
    );

    const read = await repository.read_manifest_at(mem.ctx, MANIFEST_KEY);
    expect(read?.entries.map((e) => e.object_id)).toEqual(['m1', 'm2']);
    const listing = await repository.list_snapshot_summaries(mem.ctx, OWNER);
    expect(listing.summaries.map((s) => [s.snapshot_id, s.entry_count])).toEqual([['snap-1', 2]]);
  });

  it("locks the baseline until the kept snapshot's retention ends, and not past it", async () => {
    const mem = in_memory_tenant_context();
    const put = vi.spyOn(mem.ctx.storage, 'put');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const lock = {
      requested: { mode: 'COMPLIANCE' as const, retention_days: 30 },
      effective: { mode: 'COMPLIANCE' as const, retain_until: future },
    };

    await new S3ManifestRepository().replace_with_baseline(
      mem.ctx,
      make_manifest(['m1'], { object_lock: lock }),
      stub_held_owner_lease(),
    );

    const manifest_put = put.mock.calls.find((call) => call[0] === MANIFEST_KEY);
    expect(manifest_put?.[3]).toEqual({ mode: 'COMPLIANCE', retain_until: future });
    expect(manifest_put?.[5]).toBeFalsy();
  });

  it('writes nothing when its reader would reject the baseline, or the lease is lost', async () => {
    const mem = in_memory_tenant_context();
    const broken = { ...make_manifest(['m1']), entries: 'none' } as unknown as Manifest;
    await expect(
      new S3ManifestRepository().replace_with_baseline(mem.ctx, broken, stub_held_owner_lease()),
    ).rejects.toBeInstanceOf(RefusedWriteError);

    const lost = {
      ...stub_held_owner_lease(),
      assert_held: () => {
        throw new Error('lost');
      },
    };
    await expect(
      new S3ManifestRepository().replace_with_baseline(mem.ctx, make_manifest(['m1']), lost),
    ).rejects.toThrow('lost');
    expect(mem.keys()).toEqual([]);
  });

  it('drops several summary rows in one call', async () => {
    const mem = in_memory_tenant_context();
    const repository = new S3ManifestRepository();
    for (const id of ['snap-1', 'snap-2', 'snap-3']) {
      await repository.save(mem.ctx, make_manifest(['m'], { snapshot_id: id }));
    }
    for (const id of ['snap-1', 'snap-2']) mem.remove(`manifests/${OWNER}/${id}.json`);

    await repository.forget_snapshot_summaries(mem.ctx, OWNER, ['snap-1', 'snap-2']);

    const summary_key = `_meta/outlook-manifests/owners/${OWNER}/summary.json`;
    const stored = JSON.parse(
      mem.ctx.decrypt(mem.raw(summary_key)!, summary_key).toString('utf-8'),
    );
    expect(JSON.stringify(stored)).not.toContain('snap-1');
    expect(JSON.stringify(stored)).toContain('snap-3');
  });
});
