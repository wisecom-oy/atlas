import { describe, expect, it, vi } from 'vitest';
import type { Manifest } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { load_snapshot_chain } from '@wisecom/atlas-core/services/shared/manifest-chain';
import { S3ManifestRepository } from '@/adapters/s3-manifest-repository.adapter';

const OWNER = '00000000-0000-0000-0000-00000000abcd';
const SUMMARY_KEY = `_meta/outlook-manifests/owners/${OWNER}/summary.json`;

function manifest(
  snapshot_id: string,
  created_at: string,
  extra: Partial<Manifest> = {},
): Manifest {
  return {
    id: `id-${snapshot_id}`,
    tenant_id: 'tenant-1',
    owner_id: OWNER,
    owner_email: 'user@example.com',
    snapshot_id,
    created_at: new Date(created_at),
    total_objects: 2,
    total_size_bytes: 300,
    delta_links: {},
    entries: [
      { object_id: `${snapshot_id}-a`, storage_key: 'k1', checksum: 'c1', size_bytes: 100 },
      { object_id: `${snapshot_id}-b`, storage_key: 'k2', checksum: 'c2', size_bytes: 200 },
    ],
    ...extra,
  };
}

async function three_snapshots() {
  const harness = in_memory_tenant_context();
  const repo = new S3ManifestRepository();
  await repo.save(harness.ctx, manifest('snap-1', '2026-03-01T00:00:00Z'));
  await repo.save(
    harness.ctx,
    manifest('snap-2', '2026-03-02T00:00:00Z', {
      removed_object_ids: ['snap-1-a'],
      object_lock: {
        requested: { mode: 'GOVERNANCE', retention_days: 7 },
        effective: { mode: 'GOVERNANCE', retain_until: '2099-01-01T00:00:00.000Z' },
      },
    }),
  );
  await repo.save(harness.ctx, manifest('snap-3', '2026-03-03T00:00:00Z'));
  const get = vi.spyOn(harness.ctx.storage, 'get');
  const manifest_reads = (): string[] =>
    get.mock.calls.map(([key]) => key).filter((key) => key.startsWith('manifests/'));
  return { harness, repo, manifest_reads };
}

describe('Outlook snapshot summary index (#625)', () => {
  it('records every saved snapshot beside the latest pointer, encrypted', async () => {
    const { harness } = await three_snapshots();

    const raw = harness.raw(SUMMARY_KEY)!;
    expect(raw.toString('utf-8')).not.toContain('user@example.com');
    const stored = JSON.parse(harness.ctx.decrypt(raw, SUMMARY_KEY).toString('utf-8'));
    expect(stored).toMatchObject({ format_version: 1, owner_id: OWNER });
    expect(stored.snapshots).toHaveLength(3);
  });

  it('lists the mailbox snapshots with their totals without decrypting a manifest', async () => {
    const { harness, repo, manifest_reads } = await three_snapshots();

    const listing = await repo.list_snapshot_summaries(harness.ctx, OWNER);

    expect(listing.summaries.map((s) => s.snapshot_id)).toEqual(['snap-3', 'snap-2', 'snap-1']);
    expect(listing.summaries[1]).toMatchObject({
      owner_email: 'user@example.com',
      entry_count: 2,
      total_objects: 2,
      total_size_bytes: 300,
      removed_count: 1,
      object_lock: { mode: 'GOVERNANCE', retain_until: '2099-01-01T00:00:00.000Z' },
    });
    expect(manifest_reads()).toEqual([]);
  });

  it('loads a chain without decrypting snapshots newer than the target', async () => {
    const { harness, repo, manifest_reads } = await three_snapshots();

    const chain = await load_snapshot_chain(repo, harness.ctx, 'snap-2');

    expect(chain.map((m) => m.snapshot_id)).toEqual(['snap-2', 'snap-1']);
    expect(manifest_reads()).not.toContain(`manifests/${OWNER}/snap-3.json`);
  });

  it('drops a deleted snapshot from the listing even though the summary still has its row', async () => {
    const { harness, repo } = await three_snapshots();
    harness.remove(`manifests/${OWNER}/snap-3.json`);

    const listing = await repo.list_snapshot_summaries(harness.ctx, OWNER);

    expect(listing.summaries.map((s) => s.snapshot_id)).toEqual(['snap-2', 'snap-1']);
  });
});
