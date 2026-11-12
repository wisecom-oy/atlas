/**
 * Issue #707: `restore --file-filter <typo>` restored nothing and printed success. A filter that
 * matches no file now rejects before the drive listing, and a filter that partly matches restores
 * the matches and names the rest.
 */
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '@wisecom/atlas-types';
import type {
  OneDriveConnector,
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveRestoreService } from '@/services/restore/restore.service';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';

const CONTENT = Buffer.from('file-content');
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');

const ENTRY = {
  file_id: 'file-1',
  drive_id: 'drive-1',
  file_name: 'Report.docx',
  parent_path: '/Documents',
  size_bytes: CONTENT.length,
  change_type: 'updated',
  backup_at: '2026-08-17T00:00:00.000Z',
  storage_key: 'onedrive/data/file-1',
  checksum: CHECKSUM,
} as OneDriveManifestEntry;

function make_service(): { service: OneDriveRestoreService; connector: OneDriveConnector } {
  const manifest = {
    id: 'manifest-1',
    tenant_id: 'tenant-1',
    snapshot_id: 'snap-1',
    owner_id: 'owner-1',
    created_at: new Date('2026-08-17T00:00:00.000Z'),
    total_files: 1,
    total_size_bytes: CONTENT.length,
    entries: [ENTRY],
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
  const connector = {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: 'drive-1', drive_name: 'Documents' }]),
    create_folder: vi.fn().mockResolvedValue('folder-1'),
    upload_small_file: vi.fn().mockResolvedValue(undefined),
    upload_large_file: vi.fn().mockResolvedValue(undefined),
  } as unknown as OneDriveConnector;
  const manifests = {
    find_by_snapshot: vi.fn().mockResolvedValue(manifest),
    list_readable_snapshots_by_owner: vi.fn().mockResolvedValue(readable_manifests([])),
    ...drive_chain_reads('onedrive'),
  } as unknown as OneDriveManifestRepository;
  return { service: new OneDriveRestoreService(factory, connector, manifests), connector };
}

describe('OneDrive restore with a file filter that matches nothing (issue #707)', () => {
  it('rejects with NotFoundError before listing drives or writing anything', async () => {
    const { service, connector } = make_service();

    const run = service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      file_filter: ['/no/such/file.txt'],
    });

    await expect(run).rejects.toBeInstanceOf(NotFoundError);
    await expect(run).rejects.toThrow('"/no/such/file.txt"');
    expect(connector.list_drives).not.toHaveBeenCalled();
    expect(connector.upload_small_file).not.toHaveBeenCalled();
  });

  it('restores the matches and reports the values that matched nothing', async () => {
    const { service, connector } = make_service();

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      file_filter: ['/Documents/Report.docx', '/no/such/file.txt'],
    });

    expect(result.files_restored).toBe(1);
    expect(result.unmatched_file_filters).toEqual(['/no/such/file.txt']);
    expect(connector.upload_small_file).toHaveBeenCalledTimes(1);
  });
});
