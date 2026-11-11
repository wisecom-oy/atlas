import { describe, expect, it } from 'vitest';
import type { OneDriveSnapshotManifest } from '@wisecom/atlas-types';
import { StorageError, UnreadableObjectsError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  as_manifest_listing,
  find_latest_readable_drive_manifest,
  read_drive_manifest,
  read_owner_drive_manifests,
  require_readable_drive_manifests,
  save_drive_manifest,
  type DriveManifestLayout,
} from '@/shared/drive-manifest-store';
import { build_drive_storage_keys } from '@/shared/storage-keys';

const OWNER = 'owner-1';
const LAYOUT: DriveManifestLayout = {
  label: 'OneDrive',
  keys: build_drive_storage_keys('onedrive'),
  owner_field: 'owner_id',
};

function manifest(epoch: number, owner_id = OWNER): OneDriveSnapshotManifest {
  return {
    id: `${owner_id}-${epoch}`,
    tenant_id: 'tenant-1',
    owner_id,
    snapshot_id: `od-snap-${epoch}-abc`,
    created_at: new Date(epoch),
    total_files: 0,
    total_size_bytes: 0,
    entries: [],
  };
}

/** Three snapshots of one owner with the middle one's ciphertext damaged by one byte. */
async function middle_damaged() {
  const harness = in_memory_tenant_context();
  for (const epoch of [1000, 2000, 3000]) {
    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(epoch));
  }
  const damaged_key = LAYOUT.keys.manifest_key(OWNER, 'od-snap-2000-abc');
  const bytes = Buffer.from(harness.raw(damaged_key)!);
  bytes[20]! ^= 0x01;
  harness.set_raw(damaged_key, bytes);
  return { harness, damaged_key };
}

describe('drive manifest store with a damaged manifest (issue #631)', () => {
  it('lists every readable manifest newest first and names the damaged key', async () => {
    const { harness, damaged_key } = await middle_damaged();

    const listing = as_manifest_listing(
      await read_owner_drive_manifests<OneDriveSnapshotManifest>(harness.ctx, LAYOUT, OWNER),
    );

    expect(listing.manifests.map((m) => m.snapshot_id)).toEqual([
      'od-snap-3000-abc',
      'od-snap-1000-abc',
    ]);
    expect(listing.unreadable_keys).toEqual([damaged_key]);
  });

  it('returns the newest readable manifest as the latest, naming the damaged one', async () => {
    const { harness, damaged_key } = await middle_damaged();

    const latest = await find_latest_readable_drive_manifest(harness.ctx, LAYOUT, OWNER);

    expect(latest.manifest?.snapshot_id).toBe('od-snap-3000-abc');
    expect(latest.unreadable_keys).toEqual([damaged_key]);
  });

  it('refuses the strict listing with the damaged key named', async () => {
    const { harness, damaged_key } = await middle_damaged();
    const read = await read_owner_drive_manifests(harness.ctx, LAYOUT, OWNER);

    expect(() => require_readable_drive_manifests(LAYOUT, read)).toThrow(UnreadableObjectsError);
    expect(() => require_readable_drive_manifests(LAYOUT, read)).toThrow(damaged_key);
  });

  it('names every damaged key when the strict listing meets more than one', async () => {
    const { harness, damaged_key } = await middle_damaged();
    const second = LAYOUT.keys.manifest_key(OWNER, 'od-snap-3000-abc');
    harness.set_raw(second, Buffer.from('not ciphertext'));
    const read = await read_owner_drive_manifests(harness.ctx, LAYOUT, OWNER);

    const error = (() => {
      try {
        require_readable_drive_manifests(LAYOUT, read);
      } catch (err) {
        return err as UnreadableObjectsError;
      }
      return undefined;
    })();

    expect(error?.unreadable_keys).toEqual([damaged_key, second]);
  });

  it.each([
    ['a body with no entries', { entries: undefined }],
    ['a body naming another owner', { owner_id: 'owner-2' }],
    ['an unparseable created_at', { created_at: 'not-a-date' }],
  ])('treats %s as unreadable', async (_label, overrides) => {
    const harness = in_memory_tenant_context();
    const key = LAYOUT.keys.manifest_key(OWNER, 'od-snap-1000-abc');
    const body = Buffer.from(JSON.stringify({ ...manifest(1000), ...overrides }));
    harness.set_raw(key, harness.ctx.encrypt(body, key));

    await expect(read_drive_manifest(harness.ctx, LAYOUT, key)).rejects.toMatchObject({
      code: 'ATLAS_CONTENT_UNREADABLE',
      unreadable_keys: [key],
    });
  });

  it('fails the whole listing on a storage error instead of reading it as damage', async () => {
    const { harness } = await middle_damaged();
    harness.ctx.storage.get = async () => {
      throw new Error('connection reset');
    };

    await expect(read_owner_drive_manifests(harness.ctx, LAYOUT, OWNER)).rejects.toBeInstanceOf(
      StorageError,
    );
  });
});
