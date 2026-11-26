import { describe, expect, it, vi } from 'vitest';
import type { OneDriveManifestEntry, OneDriveSnapshotManifest } from '@wisecom/atlas-types';
import { UnreadableObjectsError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { record_lock_policies } from '@wisecom/atlas-types/testing/lock-policy-recorder';
import { attach_run_retention } from '@wisecom/atlas-core/services/shared/run-object-lock';
import {
  read_drive_manifest,
  read_owner_drive_manifests,
  require_drive_manifest,
  save_drive_manifest,
  type DriveManifestLayout,
} from '@/shared/drive-manifest-store';
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
const part_key = (index: number, snapshot_id = SNAPSHOT): string =>
  LAYOUT.keys.manifest_part_key(OWNER, snapshot_id, index);

/** Thresholds a few kilobytes wide, so a test crosses them with a few dozen entries. */
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

function manifest(count: number, snapshot_id = SNAPSHOT, epoch = 1000): OneDriveSnapshotManifest {
  return {
    id: `${OWNER}-${epoch}`,
    tenant_id: 'tenant-1',
    owner_id: OWNER,
    snapshot_id,
    created_at: new Date(epoch),
    total_files: count,
    total_size_bytes: 0,
    entries: Array.from({ length: count }, (_, i) => entry(i)),
  };
}

function decrypted(harness: ReturnType<typeof in_memory_tenant_context>, key: string): unknown {
  return JSON.parse(harness.ctx.decrypt(harness.raw(key)!, key).toString('utf-8')) as unknown;
}

describe('save_drive_manifest above the single-document threshold (#920)', () => {
  it('writes entry parts and a head, and reads back every entry in order', async () => {
    const harness = in_memory_tenant_context();
    const original = manifest(200);

    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, original, SMALL);
    const loaded = await read_drive_manifest<OneDriveSnapshotManifest>(
      harness.ctx,
      LAYOUT,
      HEAD_KEY,
    );

    const parts = harness.keys().filter((key) => key.startsWith('onedrive/manifest-parts/'));
    expect(parts.length).toBeGreaterThan(4);
    expect(parts[0]).toBe(part_key(0));
    expect(loaded).toEqual(original);
    expect(loaded?.created_at).toBeInstanceOf(Date);
  });

  it('keeps every top-level field in the head and no entries, so older readers refuse it loudly', async () => {
    const harness = in_memory_tenant_context();
    const original = { ...manifest(200), object_lock: { mode: 'GOVERNANCE' } };

    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, original, SMALL);
    const head = decrypted(harness, HEAD_KEY) as Record<string, unknown>;

    expect(head).toMatchObject({
      owner_id: OWNER,
      total_files: 200,
      object_lock: { mode: 'GOVERNANCE' },
    });
    expect(head.entries).toBeUndefined();
    expect(head.entry_parts).toMatchObject({ version: 1, entry_count: 200 });
    // The check every earlier release applies to a manifest body.
    expect(() => require_drive_manifest(LAYOUT, head, HEAD_KEY)).toThrow(UnreadableObjectsError);
  });

  it('writes the head last, every object create-only and read back', async () => {
    const harness = in_memory_tenant_context();
    const put = vi.spyOn(harness.ctx.storage, 'put');
    const get = vi.spyOn(harness.ctx.storage, 'get');

    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(200), SMALL);

    const written = put.mock.calls.map(([key]) => key);
    expect(written.at(-1)).toBe(HEAD_KEY);
    expect(put.mock.calls.every((call) => call[5] === true)).toBe(true);
    expect(get.mock.calls.map(([key]) => key).sort()).toEqual([...written].sort());
  });

  it('locks every part with the run retention, like the head', async () => {
    const harness = in_memory_tenant_context();
    const recorder = record_lock_policies(harness.ctx.storage);
    const ctx = await attach_run_retention(
      { ...harness.ctx, storage: recorder.storage },
      { retention_days: 7 },
    );

    await save_drive_manifest(ctx, LAYOUT, OWNER, manifest(200), SMALL);

    expect(recorder.unlocked_keys()).toEqual([]);
    expect(recorder.locked_keys()).toContain(part_key(0));
    expect(recorder.locked_keys()).toContain(HEAD_KEY);
  });

  it('still writes one document, readable by every release, when the entries fit', async () => {
    const harness = in_memory_tenant_context();

    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(10), SMALL);

    expect(harness.keys()).toEqual([HEAD_KEY]);
    const body = decrypted(harness, HEAD_KEY);
    expect(require_drive_manifest(LAYOUT, body, HEAD_KEY).entries).toHaveLength(10);
  });

  it('gives an entry larger than a part a part of its own', async () => {
    const harness = in_memory_tenant_context();
    const original = manifest(3);
    const huge = { ...original.entries[1]!, file_name: 'x'.repeat(5_000) };
    const big = { ...original, entries: [original.entries[0]!, huge, original.entries[2]!] };

    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, big, SMALL);

    expect(harness.keys().filter((key) => key.includes('manifest-parts'))).toHaveLength(3);
    await expect(read_drive_manifest(harness.ctx, LAYOUT, HEAD_KEY)).resolves.toEqual(big);
  });
});

describe('read_drive_manifest of a multi-part manifest', () => {
  async function stored(): Promise<ReturnType<typeof in_memory_tenant_context>> {
    const harness = in_memory_tenant_context();
    await save_drive_manifest(harness.ctx, LAYOUT, OWNER, manifest(200), SMALL);
    return harness;
  }

  it('names the head when a part is missing, and a listing skips it', async () => {
    const harness = await stored();
    harness.remove(part_key(2));

    const read = read_drive_manifest(harness.ctx, LAYOUT, HEAD_KEY);
    await expect(read).rejects.toBeInstanceOf(UnreadableObjectsError);
    await expect(read).rejects.toMatchObject({ unreadable_keys: [HEAD_KEY] });
    await expect(read).rejects.toThrow(`${part_key(2)} is missing`);
    const listing = await read_owner_drive_manifests(harness.ctx, LAYOUT, OWNER);
    expect(listing.unreadable_keys).toEqual([HEAD_KEY]);
  });

  it('refuses a part re-encrypted at another position', async () => {
    const harness = await stored();
    const plaintext = harness.ctx.decrypt(harness.raw(part_key(1))!, part_key(1));
    harness.set_raw(part_key(0), harness.ctx.encrypt(plaintext, part_key(0)));

    await expect(read_drive_manifest(harness.ctx, LAYOUT, HEAD_KEY)).rejects.toThrow(
      'is not the part the manifest head recorded',
    );
  });

  it('refuses a part whose ciphertext was moved from another key', async () => {
    const harness = await stored();
    harness.set_raw(part_key(0), harness.raw(part_key(1))!);

    await expect(read_drive_manifest(harness.ctx, LAYOUT, HEAD_KEY)).rejects.toThrow(
      'does not decrypt',
    );
  });

  it('raises UnsupportedFormatVersionError for a head a newer Atlas wrote', async () => {
    const harness = await stored();
    const head = decrypted(harness, HEAD_KEY) as Record<string, unknown>;
    const newer = { ...head, entry_parts: { ...(head.entry_parts as object), version: 2 } };
    harness.set_raw(HEAD_KEY, harness.ctx.encrypt(Buffer.from(JSON.stringify(newer)), HEAD_KEY));

    await expect(read_drive_manifest(harness.ctx, LAYOUT, HEAD_KEY)).rejects.toBeInstanceOf(
      UnsupportedFormatVersionError,
    );
  });
});
