import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  OneDriveFileVersionIndex,
  OneDriveFileVersionRecord,
  OneDriveManifestRepository,
  OneDriveFileVersionIndexRepository,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveCatalogService } from '@/services/onedrive-catalog.service';

const TENANT_ID = 'tenant-1';
const OWNER_ID = 'owner-abc';

const ctx: TenantContext = {
  storage: {} as TenantContext['storage'],
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  create_cipher: vi.fn(),
  destroy: vi.fn(),
} as unknown as TenantContext;

function make_version(
  overrides: Partial<OneDriveFileVersionRecord> = {},
): OneDriveFileVersionRecord {
  return {
    snapshot_id: 'snap-1',
    backup_at: '2026-01-15T10:00:00Z',
    drive_id: 'drive-1',
    file_name: 'report.xlsx',
    parent_path: '/Documents',
    size_bytes: 2048,
    change_type: 'created',
    ...overrides,
  };
}

function make_index(
  file_id: string,
  versions: OneDriveFileVersionRecord[],
): OneDriveFileVersionIndex {
  return { file_id, owner_id: OWNER_ID, versions };
}

function create_mocks() {
  const tenant_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(ctx),
    create_readonly: vi.fn().mockResolvedValue(ctx),
    create_storage_only: vi.fn().mockResolvedValue(ctx),
  };

  const manifests = {
    list_snapshots_by_owner: vi.fn().mockResolvedValue([]),
  } as unknown as OneDriveManifestRepository;

  const indexes: OneDriveFileVersionIndexRepository = {
    write_run_index: vi.fn(),
    list_by_owner: vi.fn().mockResolvedValue([]),
  } as unknown as OneDriveFileVersionIndexRepository;

  return { tenant_factory, manifests, indexes };
}

describe('OneDriveCatalogService', () => {
  let service: OneDriveCatalogService;
  let mocks: ReturnType<typeof create_mocks>;

  beforeEach(() => {
    mocks = create_mocks();
    service = new OneDriveCatalogService(
      mocks.tenant_factory as unknown as TenantContextFactory,
      mocks.manifests,
      mocks.indexes,
    );
  });

  describe('list_onedrive_file_versions bare filename fallback', () => {
    it('resolves a bare filename to a unique basename match', async () => {
      const idx = make_index('file-bare', [make_version()]);
      vi.mocked(mocks.indexes.list_by_owner).mockResolvedValue([idx]);

      const result = await service.list_onedrive_file_versions(TENANT_ID, OWNER_ID, 'report.xlsx');

      expect(result).toHaveLength(1);
      expect(result[0].file_name).toBe('report.xlsx');
    });

    it('throws with candidate paths when a bare filename matches multiple files', async () => {
      const idx1 = make_index('file-one', [
        make_version({ parent_path: '/Documents', file_name: 'report.xlsx' }),
      ]);
      const idx2 = make_index('file-two', [
        make_version({ parent_path: '/Archive', file_name: 'report.xlsx' }),
      ]);
      vi.mocked(mocks.indexes.list_by_owner).mockResolvedValue([idx1, idx2]);

      await expect(
        service.list_onedrive_file_versions(TENANT_ID, OWNER_ID, 'report.xlsx'),
      ).rejects.toThrow(/matches 2 files.*\/Archive\/report\.xlsx.*\/Documents\/report\.xlsx/);
    });

    it('returns empty when a bare filename matches nothing', async () => {
      const result = await service.list_onedrive_file_versions(TENANT_ID, OWNER_ID, 'unknown.xlsx');

      expect(result).toEqual([]);
    });
  });
});
