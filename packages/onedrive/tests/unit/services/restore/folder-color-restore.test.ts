import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';
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

const FILE: OneDriveManifestEntry = {
  file_id: 'file-1',
  drive_id: 'drive-1',
  file_name: 'plan.docx',
  parent_path: '/Projects',
  size_bytes: CONTENT.length,
  change_type: 'created',
  backup_at: '2026-11-01T00:00:00.000Z',
  storage_key: 'onedrive/data/file-1',
  checksum: createHash('sha256').update(CONTENT).digest('hex'),
};

const COLOURED_FOLDER: OneDriveManifestEntry = {
  file_id: 'folder-1',
  drive_id: 'drive-1',
  file_name: 'Projects',
  parent_path: '/',
  size_bytes: 0,
  change_type: 'created',
  backup_at: '2026-11-01T00:00:00.000Z',
  kind: 'folder',
  folder_color: { color_hex: '6' },
};

function make_service(entries: OneDriveManifestEntry[]) {
  const manifest = {
    id: 'm-1',
    tenant_id: 'tenant-1',
    snapshot_id: 'snap-1',
    owner_id: 'owner-1',
    created_at: new Date('2026-11-01T00:00:00.000Z'),
    total_files: 1,
    total_size_bytes: CONTENT.length,
    entries,
  } as OneDriveSnapshotManifest;
  const ctx = {
    tenant_id: 'tenant-1',
    storage: { get: vi.fn().mockResolvedValue(CONTENT) },
    decrypt: vi.fn((data: Buffer) => data),
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const factory = {
    create: vi.fn().mockResolvedValue(ctx),
    create_readonly: vi.fn().mockResolvedValue(ctx),
  } as unknown as TenantContextFactory;
  let folder_seq = 0;
  // Every write the connector offers, so an attempt to set a colour would be seen.
  const connector = {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: 'drive-1', drive_name: 'Documents' }]),
    create_folder: vi.fn(async () => `folder-${++folder_seq}`),
    upload_small_file: vi.fn().mockResolvedValue('uploaded-item'),
    upload_large_file: vi.fn().mockResolvedValue('uploaded-item'),
    grant_item_access: vi.fn().mockResolvedValue({ status: 'applied' }),
    create_item_link: vi.fn().mockResolvedValue({ status: 'applied' }),
  };
  const manifests = {
    find_by_snapshot: vi.fn().mockResolvedValue(manifest),
    list_readable_snapshots_by_owner: vi.fn().mockResolvedValue(readable_manifests([])),
    ...drive_chain_reads('onedrive'),
  } as unknown as OneDriveManifestRepository;
  const service = new OneDriveRestoreService(
    factory,
    connector as unknown as OneDriveConnector,
    manifests,
    stub_owner_leases().leases,
  );
  return { service, connector };
}

describe('OneDrive restore of folder colours (#581)', () => {
  it('counts the colour as not restored without any write, and stays a clean restore', async () => {
    const { service, connector } = make_service([FILE, COLOURED_FOLDER]);

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      restore_permissions: true,
    });

    expect(result).toMatchObject({ files_restored: 1, errors: [], folders_created: 2 });
    expect(result.folder_colors_not_restored).toBe(1);
    expect(connector.create_folder).toHaveBeenCalledTimes(2);
    expect(connector.upload_small_file).toHaveBeenCalledTimes(1);
    expect(connector.grant_item_access).not.toHaveBeenCalled();
    expect(connector.create_item_link).not.toHaveBeenCalled();
  });

  it('leaves the field out when the restore selection has no coloured folder', async () => {
    const { service } = make_service([FILE, COLOURED_FOLDER]);

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      file_filter: ['/Projects/plan.docx'],
    });

    expect(result.files_restored).toBe(1);
    expect(result).not.toHaveProperty('folder_colors_not_restored');
  });
});
