import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';
import type {
  DrivePermission,
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
const GRANT: DrivePermission = { roles: ['write'], granted_to: { type: 'user', id: 'jane-id' } };

const SHARED_FILE: OneDriveManifestEntry = {
  file_id: 'file-1',
  drive_id: 'drive-1',
  file_name: 'plan.docx',
  parent_path: '/Projects',
  size_bytes: CONTENT.length,
  change_type: 'created',
  backup_at: '2026-11-01T00:00:00.000Z',
  storage_key: 'onedrive/data/file-1',
  checksum: CHECKSUM,
  permissions: [GRANT],
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

describe('OneDrive restore of permissions (#580)', () => {
  it('applies no permission without the flag, and says how many were left out', async () => {
    const { service, connector } = make_service([SHARED_FILE]);

    const result = await service.restore_onedrive('tenant-1', 'owner-1', { snapshot_id: 'snap-1' });

    expect(connector.grant_item_access).not.toHaveBeenCalled();
    expect(connector.create_item_link).not.toHaveBeenCalled();
    expect(result.files_restored).toBe(1);
    expect(result.permissions_not_requested).toBe(1);
  });

  it('reapplies the grant on the uploaded item with --restore-permissions', async () => {
    const { service, connector } = make_service([SHARED_FILE]);

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      restore_permissions: true,
    });

    expect(connector.grant_item_access).toHaveBeenCalledWith('drive-1', 'uploaded-item', {
      recipient: { object_id: 'jane-id' },
      roles: ['write'],
    });
    expect(result.permissions_applied).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('reports a grantee who no longer exists without failing the restore', async () => {
    const { service, connector } = make_service([SHARED_FILE]);
    connector.grant_item_access.mockResolvedValue({
      status: 'refused',
      refusal: 'principal_unresolved',
      message: 'One or more users could not be resolved',
    });

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      restore_permissions: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.files_restored).toBe(1);
    expect(result.permissions_skipped).toBe(1);
    expect(result.skipped_items?.[0]).toMatchObject({
      path: '/Projects/plan.docx',
      kind: 'permission',
    });
  });

  it('restores a snapshot taken before #580 exactly as before', async () => {
    const { permissions: _permissions, ...legacy } = SHARED_FILE;
    const { service, connector } = make_service([legacy]);

    const result = await service.restore_onedrive('tenant-1', 'owner-1', { snapshot_id: 'snap-1' });

    expect(result).toEqual({
      snapshot_id: 'snap-1',
      files_restored: 1,
      folders_created: 2,
      files_skipped: 0,
      errors: [],
      outcome_unknown: [],
      interrupted: false,
    });
    expect(connector.grant_item_access).not.toHaveBeenCalled();
  });
});
