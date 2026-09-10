/**
 * Issue #361. Snapshot restore resolved the target drive once, by taking the first drive Graph
 * listed, and wrote every entry into it. Each entry records its own `drive_id` and the restore
 * never read it, so a second drive's files landed in the first drive: duplicates under the
 * default rename policy, overwrites under `--conflict replace`, and silent either way because
 * every upload succeeded against real folder ids.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  OneDriveConnector,
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveRestoreService } from '@/services/restore/restore.service';

const CONTENT = Buffer.from('file-content');
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');

function make_entry(file_id: string, drive_id: string): OneDriveManifestEntry {
  return {
    file_id,
    drive_id,
    file_name: `${file_id}.txt`,
    parent_path: '/Projects',
    size_bytes: CONTENT.length,
    change_type: 'updated',
    backup_at: '2026-08-17T00:00:00.000Z',
    storage_key: `onedrive/data/${file_id}`,
    checksum: CHECKSUM,
  } as OneDriveManifestEntry;
}

interface Harness {
  service: OneDriveRestoreService;
  connector: OneDriveConnector;
}

function make_harness(entries: OneDriveManifestEntry[], target_drives: string[]): Harness {
  const manifest = {
    id: 'manifest-1',
    tenant_id: 'tenant-1',
    snapshot_id: 'snap-1',
    owner_id: 'owner-1',
    created_at: new Date('2026-08-17T00:00:00.000Z'),
    total_files: entries.length,
    total_size_bytes: entries.length * CONTENT.length,
    entries,
  } as OneDriveSnapshotManifest;

  const ctx = {
    tenant_id: 'tenant-1',
    storage: { get: vi.fn().mockResolvedValue(CONTENT) },
    encrypt: vi.fn((data: Buffer) => data),
    decrypt: vi.fn((data: Buffer) => data),
    destroy: vi.fn(),
  } as unknown as TenantContext;

  const factory = {
    create: vi.fn().mockResolvedValue(ctx),
    create_readonly: vi.fn().mockResolvedValue(ctx),
  } as unknown as TenantContextFactory;

  // Folder ids carry their drive, so where an upload landed is readable from its parent id.
  const connector = {
    list_drives: vi
      .fn()
      .mockResolvedValue(target_drives.map((id) => ({ drive_id: id, drive_name: id }))),
    create_folder: vi
      .fn()
      .mockImplementation(
        async (_t: string, _o: string, drive_id: string, _p: string, name: string) =>
          `${drive_id}/${String(name)}`,
      ),
    upload_small_file: vi.fn().mockResolvedValue(undefined),
    upload_large_file: vi.fn().mockResolvedValue(undefined),
  } as unknown as OneDriveConnector;

  const manifests = {
    find_by_snapshot: vi.fn().mockResolvedValue(manifest),
    list_snapshots_by_owner: vi.fn().mockResolvedValue([]),
  } as unknown as OneDriveManifestRepository;

  return { service: new OneDriveRestoreService(factory, connector, manifests), connector };
}

/** The drive id each upload was addressed to, in call order. */
function upload_drives(connector: OneDriveConnector): string[] {
  return vi.mocked(connector.upload_small_file).mock.calls.map((call) => String(call[2]));
}

describe('a snapshot spanning two drives', () => {
  it('restores each entry into the drive it was backed up from', async () => {
    const { service, connector } = make_harness(
      [make_entry('file-1', 'drive-a'), make_entry('file-2', 'drive-b')],
      ['drive-a', 'drive-b'],
    );

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
    });

    expect(result.files_restored).toBe(2);
    expect(upload_drives(connector).sort()).toEqual(['drive-a', 'drive-b']);
  });

  it('fails the entry whose drive is gone rather than writing it elsewhere', async () => {
    const { service, connector } = make_harness(
      [make_entry('file-1', 'drive-a'), make_entry('file-2', 'drive-gone')],
      ['drive-a'],
    );

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
    });

    expect(result.files_restored).toBe(1);
    expect(result.files_skipped).toBe(1);
    expect(result.errors[0]).toContain('drive-gone');
    expect(upload_drives(connector)).toEqual(['drive-a']);
  });

  it('refuses a cross-owner restore it cannot map', async () => {
    const { service } = make_harness(
      [make_entry('file-1', 'drive-a'), make_entry('file-2', 'drive-b')],
      ['drive-target'],
    );

    await expect(
      service.restore_onedrive('tenant-1', 'owner-1', {
        snapshot_id: 'snap-1',
        target_owner_id: 'owner-2',
      }),
    ).rejects.toThrow(/spans 2 drives/);
  });

  it('allows a cross-owner restore from a single-drive snapshot', async () => {
    const { service, connector } = make_harness(
      [make_entry('file-1', 'drive-a'), make_entry('file-2', 'drive-a')],
      ['drive-target'],
    );

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      target_owner_id: 'owner-2',
    });

    expect(result.files_restored).toBe(2);
    expect(upload_drives(connector)).toEqual(['drive-target', 'drive-target']);
  });
});
