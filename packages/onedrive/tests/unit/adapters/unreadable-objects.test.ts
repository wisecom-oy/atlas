import { describe, expect, it } from 'vitest';
import type { OneDriveSnapshotManifest } from '@wisecom/atlas-types';
import { UnreadableObjectsError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3OneDriveManifestRepository } from '@/adapters/s3-onedrive-manifest-repository.adapter';
import { S3OneDriveFileVersionIndexRepository } from '@/adapters/s3-onedrive-file-version-index-repository.adapter';

const OWNER = 'owner-1';

function manifest(epoch: number): OneDriveSnapshotManifest {
  return {
    id: `${OWNER}-${epoch}`,
    tenant_id: 'tenant-1',
    owner_id: OWNER,
    snapshot_id: `od-snap-${epoch}-abc`,
    created_at: new Date(epoch),
    total_files: 0,
    total_size_bytes: 0,
    entries: [],
  };
}

function damage(harness: ReturnType<typeof in_memory_tenant_context>, key: string): void {
  const bytes = Buffer.from(harness.raw(key)!);
  bytes[bytes.length - 1]! ^= 0x80;
  harness.set_raw(key, bytes);
}

describe('S3OneDriveManifestRepository with a damaged manifest (issue #631)', () => {
  async function two_snapshots_older_damaged() {
    const harness = in_memory_tenant_context();
    const repo = new S3OneDriveManifestRepository();
    await repo.save(harness.ctx, manifest(1000));
    await repo.save(harness.ctx, manifest(2000));
    const damaged_key = `onedrive/manifests/${OWNER}/od-snap-1000-abc.json`;
    damage(harness, damaged_key);
    return { harness, repo, damaged_key };
  }

  it('lists the readable snapshots and names the damaged key', async () => {
    const { harness, repo, damaged_key } = await two_snapshots_older_damaged();

    const listing = await repo.list_readable_snapshots_by_owner(harness.ctx, OWNER);

    expect(listing.manifests.map((m) => m.snapshot_id)).toEqual(['od-snap-2000-abc']);
    expect(listing.unreadable_keys).toEqual([damaged_key]);
  });

  it('reports the newest readable snapshot and the damaged key for status', async () => {
    const { harness, repo, damaged_key } = await two_snapshots_older_damaged();

    const latest = await repo.find_latest_readable(harness.ctx, OWNER);

    expect(latest.manifest?.snapshot_id).toBe('od-snap-2000-abc');
    expect(latest.unreadable_keys).toEqual([damaged_key]);
  });

  it('keeps the strict listing replication and stats read refusing, naming the key', async () => {
    const { harness, repo, damaged_key } = await two_snapshots_older_damaged();

    const read = repo.list_snapshots_by_owner(harness.ctx, OWNER);

    await expect(read).rejects.toBeInstanceOf(UnreadableObjectsError);
    await expect(read).rejects.toMatchObject({ unreadable_keys: [damaged_key] });
    await expect(repo.list_all_manifests(harness.ctx)).rejects.toThrow(damaged_key);
  });

  it('refuses the damaged snapshot itself by id and by key', async () => {
    const { harness, repo, damaged_key } = await two_snapshots_older_damaged();

    await expect(repo.find_by_snapshot(harness.ctx, OWNER, 'od-snap-1000-abc')).rejects.toThrow(
      damaged_key,
    );
    await expect(repo.read_manifest_at(harness.ctx, damaged_key)).rejects.toBeInstanceOf(
      UnreadableObjectsError,
    );
  });
});

describe('S3OneDriveFileVersionIndexRepository with a damaged index object (issue #631)', () => {
  const repo = new S3OneDriveFileVersionIndexRepository();

  it('reads one index object exactly, raising for damage and resolving absence', async () => {
    const harness = in_memory_tenant_context();
    await repo.write_run_index(harness.ctx, OWNER, 'od-snap-1000-abc', [
      { file_id: 'file-1', owner_id: OWNER, versions: [] },
    ]);
    const key = `onedrive/index/${OWNER}/runs/od-snap-1000-abc.json`;

    await expect(repo.read_index_object_at(harness.ctx, key)).resolves.toHaveLength(1);
    damage(harness, key);
    await expect(repo.read_index_object_at(harness.ctx, key)).rejects.toMatchObject({
      unreadable_keys: [key],
    });
    await expect(repo.read_index_object_at(harness.ctx, `${key}.missing`)).resolves.toBeUndefined();
  });
});
