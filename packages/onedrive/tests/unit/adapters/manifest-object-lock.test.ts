import { describe, expect, it, vi } from 'vitest';
import type { ManifestObjectLockPolicy, OneDriveSnapshotManifest } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3OneDriveManifestRepository } from '@/adapters/s3-onedrive-manifest-repository.adapter';
import { ONEDRIVE_KEYS } from '@/services/shared/storage-keys';

/**
 * Issue #975: a OneDrive manifest records the Object Lock policy its run applied, and the
 * owner's summary row carries the applied half so a listing need not decrypt the manifest.
 */

const OWNER = 'owner-1';
const LOCK: ManifestObjectLockPolicy = {
  requested: { mode: 'COMPLIANCE', retention_days: 30 },
  effective: { mode: 'COMPLIANCE', retain_until: '2099-01-01T00:00:00.000Z' },
};

function manifest(
  snapshot_id: string,
  created_at: string,
  object_lock?: ManifestObjectLockPolicy,
): OneDriveSnapshotManifest {
  return {
    id: `${OWNER}-${snapshot_id}`,
    tenant_id: 'tenant-1',
    owner_id: OWNER,
    snapshot_id,
    created_at: new Date(created_at),
    total_files: 0,
    total_size_bytes: 0,
    ...(object_lock ? { object_lock } : {}),
    entries: [],
  };
}

async function saved_pair() {
  const harness = in_memory_tenant_context();
  const repo = new S3OneDriveManifestRepository();
  await repo.save(harness.ctx, manifest('od-snap-1', '2026-03-01T00:00:00Z'));
  await repo.save(harness.ctx, manifest('od-snap-2', '2026-03-02T00:00:00Z', LOCK));
  return { harness, repo };
}

describe('OneDrive manifest Object Lock record (#975)', () => {
  it('reads the policy back from the manifest and nothing from an unlocked one', async () => {
    const { harness, repo } = await saved_pair();

    const listing = await repo.list_readable_snapshots_by_owner(harness.ctx, OWNER);

    const [locked, unlocked] = listing.manifests;
    expect(locked?.object_lock).toEqual(LOCK);
    expect(unlocked).not.toHaveProperty('object_lock');
  });

  it('lists the applied policy from the summary row without decrypting a manifest', async () => {
    const { harness, repo } = await saved_pair();
    const get = vi.spyOn(harness.ctx.storage, 'get');

    const listing = await repo.list_snapshot_summaries(harness.ctx, OWNER);

    expect(listing.summaries[0]?.object_lock).toEqual(LOCK.effective);
    expect(listing.summaries[1]).not.toHaveProperty('object_lock');
    const manifest_reads = get.mock.calls.filter(([key]) => key.startsWith('onedrive/manifests'));
    expect(manifest_reads).toEqual([]);
  });

  it('reports no policy for a manifest an earlier release wrote', async () => {
    const harness = in_memory_tenant_context();
    const repo = new S3OneDriveManifestRepository();
    await repo.save(harness.ctx, manifest('od-snap-1', '2026-03-01T00:00:00Z'));
    // Without the summary index the listing decrypts the manifest itself, as after an upgrade.
    harness.remove(ONEDRIVE_KEYS.snapshot_summary_key(OWNER));

    const listing = await repo.list_snapshot_summaries(harness.ctx, OWNER);

    expect(listing.unreadable_keys).toEqual([]);
    expect(listing.summaries).toHaveLength(1);
    expect(listing.summaries[0]).not.toHaveProperty('object_lock');
  });

  it('rebuilds a row whose stored policy is malformed from its manifest', async () => {
    const { harness, repo } = await saved_pair();
    const key = ONEDRIVE_KEYS.snapshot_summary_key(OWNER);
    const stored = JSON.parse(harness.ctx.decrypt(harness.raw(key)!, key).toString('utf-8'));
    const row = stored.snapshots.find(
      (r: { snapshot_id: string }) => r.snapshot_id === 'od-snap-2',
    );
    row.object_lock = { mode: 'NONE' };
    harness.set_raw(key, harness.ctx.encrypt(Buffer.from(JSON.stringify(stored)), key));

    const listing = await repo.list_snapshot_summaries(harness.ctx, OWNER);

    expect(listing.summaries[0]?.object_lock).toEqual(LOCK.effective);
  });
});
