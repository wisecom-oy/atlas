import { describe, expect, it } from 'vitest';
import type { OneDriveManifestEntry, OneDriveSnapshotManifest } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  read_drive_manifest,
  save_drive_manifest,
  type DriveManifestLayout,
} from '@/shared/drive-manifest-store';
import { replace_drive_manifest } from '@/shared/manifest-baseline-replace';
import type { ManifestSizing } from '@/shared/manifest-part-writer';
import { build_drive_storage_keys } from '@/shared/storage-keys';

const OWNER = 'owner-1';
const SNAPSHOT = 'od-snap-1000-abc';
const LAYOUT: DriveManifestLayout = {
  label: 'OneDrive',
  keys: build_drive_storage_keys('onedrive'),
  owner_field: 'owner_id',
};
const HEAD_KEY = LAYOUT.keys.manifest_key(OWNER, SNAPSHOT);
const PARTS_PREFIX = LAYOUT.keys.manifest_snapshot_parts_prefix(OWNER, SNAPSHOT);

/** Thresholds a few kilobytes wide, so a few dozen entries cross them. */
const SMALL: ManifestSizing = {
  single_document_bytes: 4_000,
  part_bytes: 1_000,
  write_concurrency: 2,
};

function entry(index: number): OneDriveManifestEntry {
  return {
    file_id: `file-${String(index).padStart(4, '0')}`,
    drive_id: 'drive-1',
    file_name: `report-${index}.docx`,
    parent_path: '/drive/root:/Documents',
    size_bytes: index,
    storage_key: `onedrive/data/${OWNER}/blob-${index}`,
    backup_at: '2026-01-01T00:00:00.000Z',
    change_type: 'created',
  };
}

function manifest(count: number): OneDriveSnapshotManifest {
  return {
    id: 'id-1',
    tenant_id: 'tenant-1',
    owner_id: OWNER,
    snapshot_id: SNAPSHOT,
    created_at: new Date(1000),
    total_files: count,
    total_size_bytes: 0,
    entries: Array.from({ length: count }, (_, i) => entry(i)),
  };
}

function stores_parts(harness: ReturnType<typeof in_memory_tenant_context>): boolean {
  const body = JSON.parse(harness.ctx.decrypt(harness.raw(HEAD_KEY)!, HEAD_KEY).toString('utf-8'));
  return 'entry_parts' in body;
}

describe('replace_drive_manifest (#977)', () => {
  it('replaces a one-document manifest with a larger baseline written in parts', async () => {
    const harness = in_memory_tenant_context();
    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(3), SMALL);

    await replace_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(200), undefined, SMALL);

    const read = await read_drive_manifest<OneDriveSnapshotManifest>(harness.ctx, LAYOUT, HEAD_KEY);
    expect(read?.entries).toHaveLength(200);
    expect(stores_parts(harness)).toBe(true);
  });

  it('replaces a manifest stored in parts with one document, and removes the parts', async () => {
    const harness = in_memory_tenant_context();
    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(200), SMALL);
    expect(harness.keys().filter((key) => key.startsWith(PARTS_PREFIX)).length).toBeGreaterThan(1);

    await replace_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(250), undefined, SMALL);

    const read = await read_drive_manifest<OneDriveSnapshotManifest>(harness.ctx, LAYOUT, HEAD_KEY);
    expect(read?.entries).toHaveLength(250);
    expect(stores_parts(harness)).toBe(false);
    expect(harness.keys().filter((key) => key.startsWith(PARTS_PREFIX))).toEqual([]);
  });

  it('overwrites the parts an interrupted earlier replace left, and drops the ones past the end', async () => {
    const harness = in_memory_tenant_context();
    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(3), SMALL);
    harness.set_raw(LAYOUT.keys.manifest_part_key(OWNER, SNAPSHOT, 0), Buffer.from('left over'));
    harness.set_raw(LAYOUT.keys.manifest_part_key(OWNER, SNAPSHOT, 999), Buffer.from('left over'));

    await replace_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(200), undefined, SMALL);

    const read = await read_drive_manifest<OneDriveSnapshotManifest>(harness.ctx, LAYOUT, HEAD_KEY);
    expect(read?.entries).toHaveLength(200);
    expect(harness.keys()).not.toContain(LAYOUT.keys.manifest_part_key(OWNER, SNAPSHOT, 999));
  });
});
