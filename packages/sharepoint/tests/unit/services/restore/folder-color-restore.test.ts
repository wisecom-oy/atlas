import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';
import type {
  SharePointManifestEntry,
  SharePointManifestRepository,
  SharePointSiteConnector,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { SharePointRestoreService } from '@/services/restore/restore.service';

vi.mock('@wisecom/atlas-drive/restore/streaming-restore', () => ({
  should_stream_restore: vi.fn().mockReturnValue(false),
  verify_streaming_checksum: vi.fn().mockReturnValue(true),
}));

const CONTENT = Buffer.from('restored-file-content');

const FILE: SharePointManifestEntry = {
  file_id: 'sp-file-1',
  drive_id: 'source-drive',
  library_name: 'Documents',
  file_name: 'report.docx',
  parent_path: '/Reports',
  size_bytes: CONTENT.length,
  change_type: 'created',
  backup_at: '2026-11-01T00:00:00.000Z',
  storage_key: 'sharepoint/data/source-site/abc',
  checksum: createHash('sha256').update(CONTENT).digest('hex'),
};

const COLOURED_FOLDER: SharePointManifestEntry = {
  file_id: 'sp-folder-1',
  drive_id: 'source-drive',
  library_name: 'Documents',
  file_name: 'Reports',
  parent_path: '/',
  size_bytes: 0,
  change_type: 'created',
  backup_at: '2026-11-01T00:00:00.000Z',
  kind: 'folder',
  folder_color: { color_hex: '6' },
};

function make_service(entries: SharePointManifestEntry[]) {
  const ctx = {
    storage: { get: vi.fn().mockResolvedValue(CONTENT) },
    decrypt: vi.fn((buf: Buffer) => buf),
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const factory = {
    create: vi.fn().mockResolvedValue(ctx),
    create_readonly: vi.fn().mockResolvedValue(ctx),
  } as unknown as TenantContextFactory;
  // Every write the connector offers, so an attempt to set a colour would be seen.
  const connector = {
    list_document_libraries: vi
      .fn()
      .mockResolvedValue([{ drive_id: 'target-drive', drive_name: 'Documents' }]),
    create_folder: vi.fn().mockResolvedValue('folder-id'),
    upload_small_file: vi.fn().mockResolvedValue('uploaded-item'),
    upload_large_file: vi.fn().mockResolvedValue('uploaded-item'),
    grant_item_access: vi.fn().mockResolvedValue({ status: 'applied' }),
    create_item_link: vi.fn().mockResolvedValue({ status: 'applied' }),
  };
  const manifests = {
    find_by_snapshot: vi.fn().mockResolvedValue({
      snapshot_id: 'sp-snap-1',
      site_id: 'source-site',
      created_at: new Date('2026-11-01T00:00:00Z'),
      total_files: 1,
      entries,
    }),
    list_readable_snapshots_by_site: vi.fn().mockResolvedValue(readable_manifests([])),
    ...drive_chain_reads('sharepoint'),
  } as unknown as SharePointManifestRepository;
  const service = new SharePointRestoreService(
    factory,
    connector as unknown as SharePointSiteConnector,
    manifests,
    stub_owner_leases().leases,
  );
  return { service, connector };
}

describe('SharePoint restore of folder colours (#581)', () => {
  it('counts the colour as not restored into another site, with no write for it', async () => {
    const { service, connector } = make_service([FILE, COLOURED_FOLDER]);

    const result = await service.restore_sharepoint('tenant-1', 'source-site', {
      snapshot_id: 'sp-snap-1',
      target_site_id: 'target-site',
      restore_permissions: true,
    });

    expect(result).toMatchObject({ files_restored: 1, errors: [] });
    expect(result.folder_colors_not_restored).toBe(1);
    expect(connector.upload_small_file).toHaveBeenCalledTimes(1);
    expect(connector.grant_item_access).not.toHaveBeenCalled();
    expect(connector.create_item_link).not.toHaveBeenCalled();
  });

  it('restores a snapshot taken before colours were captured exactly as before', async () => {
    const { service } = make_service([FILE]);

    const result = await service.restore_sharepoint('tenant-1', 'source-site', {
      snapshot_id: 'sp-snap-1',
      target_site_id: 'target-site',
    });

    expect(result).toEqual({
      snapshot_id: 'sp-snap-1',
      files_restored: 1,
      folders_created: 2,
      files_skipped: 0,
      errors: [],
      interrupted: false,
    });
  });
});
