import { describe, expect, it } from 'vitest';
import type { OneDriveSnapshotManifest } from '@wisecom/atlas-types';
import { StoredObjectConflictError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { stub_held_owner_lease } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { S3OneDriveFileVersionIndexRepository } from '@/adapters/s3-onedrive-file-version-index-repository.adapter';
import { S3OneDriveManifestRepository } from '@/adapters/s3-onedrive-manifest-repository.adapter';

const OWNER = 'cccccccc-0000-4000-8000-000000000003';
const SNAPSHOT = 'snap-onedrive-1000-ab';

function make_manifest(files: string[]): OneDriveSnapshotManifest {
  return {
    id: 'id-1',
    tenant_id: 'tenant-1',
    owner_id: OWNER,
    snapshot_id: SNAPSHOT,
    created_at: new Date(1000),
    total_files: files.length,
    total_size_bytes: 0,
    entries: files.map((file_id) => ({
      file_id,
      drive_id: 'drive-1',
      file_name: `${file_id}.txt`,
      parent_path: '/',
      size_bytes: 1,
      backup_at: '2026-01-01T00:00:00.000Z',
      change_type: 'created',
    })),
  };
}

describe('S3OneDriveManifestRepository baseline writes (#977)', () => {
  it('replaces a stored manifest, which save refuses, and rewrites its summary row', async () => {
    const mem = in_memory_tenant_context();
    const repository = new S3OneDriveManifestRepository();
    await repository.save(mem.ctx, make_manifest(['f1']));
    await expect(repository.save(mem.ctx, make_manifest(['f1', 'f2']))).rejects.toBeInstanceOf(
      StoredObjectConflictError,
    );

    await repository.replace_with_baseline(
      mem.ctx,
      make_manifest(['f1', 'f2']),
      stub_held_owner_lease(),
    );

    const found = await repository.find_by_snapshot(mem.ctx, OWNER, SNAPSHOT);
    expect(found?.entries.map((e) => e.file_id)).toEqual(['f1', 'f2']);
    const listing = await repository.list_snapshot_summaries(mem.ctx, OWNER);
    expect(listing.summaries.map((s) => s.entry_count)).toEqual([2]);
  });

  it('drops the rows of removed snapshots in one call', async () => {
    const mem = in_memory_tenant_context();
    const repository = new S3OneDriveManifestRepository();
    await repository.save(mem.ctx, make_manifest(['f1']));

    await repository.forget_snapshot_summaries(mem.ctx, OWNER, [SNAPSHOT]);

    const listing = await repository.list_snapshot_summaries(mem.ctx, OWNER);
    // The manifest is still listed, so reads keep its row; the stored summary dropped it.
    expect(listing.summaries.map((s) => s.snapshot_id)).toEqual([SNAPSHOT]);
  });
});

describe('S3OneDriveFileVersionIndexRepository.replace_run_index (#977)', () => {
  it('overwrites a run index, which write_run_index refuses', async () => {
    const mem = in_memory_tenant_context();
    const indexes = new S3OneDriveFileVersionIndexRepository();
    const row = (file_id: string) => ({
      file_id,
      owner_id: OWNER,
      versions: [
        {
          snapshot_id: SNAPSHOT,
          backup_at: '2026-01-01T00:00:00.000Z',
          drive_id: 'drive-1',
          file_name: 'x',
          parent_path: '/',
          size_bytes: 1,
          change_type: 'created' as const,
        },
      ],
    });
    await indexes.write_run_index(mem.ctx, OWNER, SNAPSHOT, [row('f1')]);
    await expect(indexes.write_run_index(mem.ctx, OWNER, SNAPSHOT, [row('f2')])).rejects.toThrow();

    await indexes.replace_run_index(mem.ctx, OWNER, SNAPSHOT, [row('f1'), row('f2')]);

    const listing = await indexes.list_readable_by_owner(mem.ctx, OWNER);
    expect(listing.indexes.map((i) => i.file_id).sort()).toEqual(['f1', 'f2']);
  });
});
