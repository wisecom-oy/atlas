import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OneDriveSnapshotManifest } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  read_owner_drive_manifests,
  save_drive_manifest,
  type DriveManifestLayout,
} from '@/shared/drive-manifest-store';
import type { ManifestSizing } from '@/shared/manifest-part-writer';
import { build_drive_storage_keys } from '@/shared/storage-keys';

const OWNER = 'owner-1';
const LAYOUT: DriveManifestLayout = {
  label: 'OneDrive',
  keys: build_drive_storage_keys('onedrive'),
  owner_field: 'owner_id',
};
const SMALL: ManifestSizing = {
  single_document_bytes: 2_000,
  part_bytes: 500,
  write_concurrency: 1,
};

function manifest(epoch: number, count: number): OneDriveSnapshotManifest {
  return {
    id: `${OWNER}-${epoch}`,
    tenant_id: 'tenant-1',
    owner_id: OWNER,
    snapshot_id: `od-snap-${epoch}-abc`,
    created_at: new Date(epoch),
    total_files: count,
    total_size_bytes: 0,
    entries: Array.from({ length: count }, (_, i) => ({
      file_id: `file-${i}`,
      drive_id: 'drive-1',
      file_name: `file-${i}.txt`,
      parent_path: '/drive/root:',
      size_bytes: i,
      backup_at: '2026-01-01T00:00:00.000Z',
      change_type: 'created' as const,
    })),
  };
}

/** Moves the clock a day and a minute ahead, so everything written so far is old enough to sweep. */
function a_day_later(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 60_000);
}

const parts_of = (keys: string[], epoch: number): string[] =>
  keys.filter((key) => key.startsWith(`onedrive/manifest-parts/${OWNER}/od-snap-${epoch}-abc/`));

/** Saves a manifest whose head PUT fails, as a backup interrupted after its parts would leave. */
async function interrupted_save(harness: ReturnType<typeof in_memory_tenant_context>) {
  const head_key = LAYOUT.keys.manifest_key(OWNER, 'od-snap-1000-abc');
  const put = harness.ctx.storage.put.bind(harness.ctx.storage);
  const spy = vi.spyOn(harness.ctx.storage, 'put').mockImplementation(async (key, ...rest) => {
    if (key === head_key) throw new Error('connection reset');
    return put(key, ...rest);
  });
  await expect(
    save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(1000, 60), SMALL),
  ).rejects.toThrow('connection reset');
  spy.mockRestore();
}

describe('an interrupted multi-part manifest write (#920)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves parts but no snapshot, so no reader sees half a manifest', async () => {
    const harness = in_memory_tenant_context();

    await interrupted_save(harness);

    expect(parts_of(harness.keys(), 1000).length).toBeGreaterThan(1);
    const listing = await read_owner_drive_manifests(harness.ctx, LAYOUT, OWNER);
    expect(listing.items).toEqual([]);
    expect(listing.unreadable_keys).toEqual([]);
  });

  it('has its orphan parts removed by a save of the owner a day later', async () => {
    const harness = in_memory_tenant_context();
    await interrupted_save(harness);
    a_day_later();

    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(2000, 60), SMALL);

    expect(parts_of(harness.keys(), 1000)).toEqual([]);
    expect(parts_of(harness.keys(), 2000).length).toBeGreaterThan(1);
    const listing = await read_owner_drive_manifests(harness.ctx, LAYOUT, OWNER);
    expect(listing.items.map((m) => m.snapshot_id)).toEqual(['od-snap-2000-abc']);
  });

  it('leaves fresh orphan parts alone, since a run that took over the lease may own them', async () => {
    const harness = in_memory_tenant_context();
    await interrupted_save(harness);

    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(2000, 1), SMALL);

    expect(parts_of(harness.keys(), 1000).length).toBeGreaterThan(1);
  });

  it('keeps the parts of a manifest whose head was moved to quarantine', async () => {
    const harness = in_memory_tenant_context();
    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(1000, 60), SMALL);
    const head_key = LAYOUT.keys.manifest_key(OWNER, 'od-snap-1000-abc');
    harness.set_raw(`_quarantine/${head_key}.1767225600000`, harness.raw(head_key)!);
    harness.remove(head_key);
    a_day_later();

    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(2000, 1), SMALL);

    expect(parts_of(harness.keys(), 1000).length).toBeGreaterThan(1);
  });

  it('logs instead of failing the save when the sweep cannot list', async () => {
    const harness = in_memory_tenant_context();
    const list = harness.ctx.storage.list.bind(harness.ctx.storage);
    vi.spyOn(harness.ctx.storage, 'list').mockImplementation(async (prefix, limit) => {
      if (prefix.includes('manifest-parts')) throw new Error('access denied');
      return list(prefix, limit);
    });
    vi.spyOn(harness.ctx.storage, 'list_stale').mockRejectedValue(new Error('access denied'));

    await expect(
      save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(1000, 1), SMALL),
    ).resolves.toBeUndefined();
  });
});
