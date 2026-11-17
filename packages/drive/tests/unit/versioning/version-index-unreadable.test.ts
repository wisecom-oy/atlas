import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantContextFactory } from '@wisecom/atlas-types';
import { UnreadableObjectsError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import type { DriveFileVersionIndexView, DriveFileVersionRecord } from '@/drive-ports';
import { list_drive_file_versions } from '@/catalog/catalog-queries';
import { restore_drive_version } from '@/restore/version-restore';
import { read_merged_version_indexes } from '@/versioning/version-index-store';

const OWNER = 'owner-1';
const GOOD_KEY = `onedrive/index/${OWNER}/runs/od-snap-1000-abc.json`;
const DAMAGED_KEY = `onedrive/index/${OWNER}/runs/od-snap-2000-abc.json`;

function version(version_id: string, backup_at: string): DriveFileVersionRecord {
  return {
    snapshot_id: 'od-snap-1000-abc',
    backup_at,
    drive_id: 'drive-1',
    file_name: 'report.docx',
    parent_path: '/Documents',
    size_bytes: 7,
    storage_key: `onedrive/data/${OWNER}/${version_id}`,
    checksum: 'abc',
    change_type: 'updated',
    last_modified_at: backup_at,
    version_id,
  };
}

const READABLE: DriveFileVersionIndexView[] = [
  { file_id: 'file-1', versions: [version('1.0', '2026-03-01T00:00:00.000Z')] },
];

/** A bucket with one readable run index and one whose ciphertext lost its tail. */
function bucket_with_damaged_index() {
  const harness = in_memory_tenant_context();
  const body = Buffer.from(JSON.stringify({ owner_id: OWNER, indexes: READABLE }));
  harness.set_raw(GOOD_KEY, harness.ctx.encrypt(body, GOOD_KEY));
  harness.set_raw(DAMAGED_KEY, harness.ctx.encrypt(body, DAMAGED_KEY).subarray(0, 30));
  return harness;
}

function factory_for(ctx: TenantContext): TenantContextFactory {
  return { create_readonly: async () => ctx } as unknown as TenantContextFactory;
}

describe('version index damage is reported, not swallowed (issue #631)', () => {
  it('merges the readable index objects and names the damaged one', async () => {
    const harness = bucket_with_damaged_index();

    const merged = await read_merged_version_indexes(harness.ctx, [GOOD_KEY, DAMAGED_KEY]);

    expect([...merged.versions_by_file.keys()]).toEqual(['file-1']);
    expect(merged.unreadable_keys).toEqual([DAMAGED_KEY]);
  });

  it('fails a version listing with the key named, carrying the rows it could read', async () => {
    const harness = in_memory_tenant_context();
    const deps = {
      tenant_factory: factory_for(harness.ctx),
      list_snapshots: vi.fn(),
      list_indexes: async () => ({ indexes: READABLE, unreadable_keys: [DAMAGED_KEY] }),
    };

    const error = await list_drive_file_versions(deps, 'tenant-1', OWNER, 'file-1').catch(
      (err: unknown) => err as UnreadableObjectsError,
    );

    expect(error).toBeInstanceOf(UnreadableObjectsError);
    expect((error as UnreadableObjectsError).unreadable_keys).toEqual([DAMAGED_KEY]);
    expect((error as UnreadableObjectsError).partial_result).toEqual(READABLE[0]!.versions);
  });

  it('refuses a version restore rather than choosing from an incomplete history', async () => {
    const harness = in_memory_tenant_context();
    const download_blob = vi.fn();

    const restore = restore_drive_version(
      {
        workload: 'onedrive',
        tenant_factory: factory_for(harness.ctx),
        leases: stub_owner_leases().leases,
        connector: { upload_small_file: vi.fn(), upload_large_file: vi.fn() },
        list_indexes: async () => ({ indexes: READABLE, unreadable_keys: [DAMAGED_KEY] }),
        download_blob,
        ensure_folder_path: vi.fn(),
      },
      'tenant-1',
      OWNER,
      { before: new Date('2026-04-01T00:00:00Z') },
    );

    // The newest version before the cutoff may be the one in the unreadable object, so going on
    // would roll the file back to older bytes than the operator asked for.
    await expect(restore).rejects.toMatchObject({ unreadable_keys: [DAMAGED_KEY] });
    expect(download_blob).not.toHaveBeenCalled();
  });

  it('fails on an index object a newer Atlas wrote instead of skipping it', async () => {
    const harness = bucket_with_damaged_index();
    const decrypt = harness.ctx.decrypt;
    harness.ctx.decrypt = (data, key) => {
      if (key === GOOD_KEY) throw new UnsupportedFormatVersionError('Unsupported content envelope');
      return decrypt(data, key);
    };

    await expect(read_merged_version_indexes(harness.ctx, [GOOD_KEY])).rejects.toBeInstanceOf(
      UnsupportedFormatVersionError,
    );
  });
});
