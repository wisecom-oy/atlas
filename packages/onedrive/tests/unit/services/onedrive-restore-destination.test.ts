/**
 * Issue #217: a restore must be separable from live content and reversible.
 *
 * The regression these guard against is silent: with `--conflict rename` an in-place restore never
 * fails, it just leaves another suffixed copy beside every original. So the assertions are on where
 * uploads land, not on whether the restore reported success.
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
import { OneDriveRestoreService } from '@/services/onedrive-restore.service';

const CONTENT = Buffer.from('file-content');
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');

function make_entry(file_id: string, parent_path = '/Projects/2026'): OneDriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name: `${file_id}.txt`,
    parent_path,
    size_bytes: CONTENT.length,
    change_type: 'updated',
    backup_at: '2026-08-17T00:00:00.000Z',
    storage_key: `onedrive/data/${file_id}`,
    checksum: CHECKSUM,
  } as OneDriveManifestEntry;
}

function make_service(entries: OneDriveManifestEntry[]): {
  service: OneDriveRestoreService;
  connector: OneDriveConnector;
} {
  const manifest = {
    id: 'manifest-1',
    tenant_id: 'tenant-1',
    snapshot_id: 'snap-1',
    owner_id: 'owner-1',
    created_at: new Date('2026-08-17T00:00:00.000Z'),
    total_files: entries.length,
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
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

  // Each created folder gets a distinct id so nesting is provable, not assumed.
  let folder_seq = 0;
  const connector = {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: 'drive-1', drive_name: 'Documents' }]),
    create_folder: vi.fn().mockImplementation(async () => `folder-${++folder_seq}`),
    upload_small_file: vi.fn().mockResolvedValue(undefined),
    upload_large_file: vi.fn().mockResolvedValue(undefined),
  } as unknown as OneDriveConnector;

  const manifests = {
    find_by_snapshot: vi.fn().mockResolvedValue(manifest),
    list_snapshots_by_owner: vi.fn().mockResolvedValue([]),
  } as unknown as OneDriveManifestRepository;

  return { service: new OneDriveRestoreService(factory, connector, manifests), connector };
}

/** Folder names created, in order, so a restore's shape can be read directly. */
function created_folders(connector: OneDriveConnector): string[] {
  return vi.mocked(connector.create_folder).mock.calls.map((call) => String(call[4]));
}

describe('OneDrive restore destination (issue #217)', () => {
  it('nests the restore under a generated root by default', async () => {
    const { service, connector } = make_service([make_entry('file-1')]);

    await service.restore_onedrive('tenant-1', 'owner-1', { snapshot_id: 'snap-1' });

    const [root, ...nested] = created_folders(connector);
    expect(root).toMatch(/^Restore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    expect(nested).toEqual(['Projects', '2026']);
    // The upload must target the deepest folder created under the root, not the drive root.
    expect(vi.mocked(connector.upload_small_file).mock.calls[0]![3]).toBe('folder-3');
  });

  it('creates the root once for a whole restore, not once per file', async () => {
    const { service, connector } = make_service([
      make_entry('file-1'),
      make_entry('file-2'),
      make_entry('file-3', '/Reports'),
    ]);

    await service.restore_onedrive('tenant-1', 'owner-1', { snapshot_id: 'snap-1' });

    const roots = created_folders(connector).filter((name) => name.startsWith('Restore-'));
    expect(roots).toHaveLength(1);
  });

  it('writes to the original paths only when --in-place is given', async () => {
    const { service, connector } = make_service([make_entry('file-1')]);

    await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      in_place: true,
    });

    expect(created_folders(connector)).toEqual(['Projects', '2026']);
  });

  it('restores under a caller-chosen destination', async () => {
    const { service, connector } = make_service([make_entry('file-1')]);

    await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      destination: '/DR-drill',
    });

    expect(created_folders(connector)).toEqual(['DR-drill', 'Projects', '2026']);
  });

  it('renames a single-file restore', async () => {
    const { service, connector } = make_service([make_entry('file-1')]);

    await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      rename_to: 'Report-copy.txt',
    });

    expect(vi.mocked(connector.upload_small_file).mock.calls[0]![4]).toBe('Report-copy.txt');
  });

  it('refuses to rename when the restore resolves to more than one file', async () => {
    const { service, connector } = make_service([make_entry('file-1'), make_entry('file-2')]);

    await expect(
      service.restore_onedrive('tenant-1', 'owner-1', {
        snapshot_id: 'snap-1',
        rename_to: 'Report-copy.txt',
      }),
    ).rejects.toThrow(/single file/);
    // Refusing after writing half the files would be worse than not refusing at all.
    expect(connector.upload_small_file).not.toHaveBeenCalled();
  });

  it('reports a failed root as a per-item skip instead of aborting the run', async () => {
    const { service, connector } = make_service([make_entry('file-1'), make_entry('file-2')]);
    vi.mocked(connector.create_folder).mockRejectedValue(new Error('path too long'));

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
    });

    expect(result.files_restored).toBe(0);
    expect(result.files_skipped).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(connector.upload_small_file).not.toHaveBeenCalled();
  });
});
