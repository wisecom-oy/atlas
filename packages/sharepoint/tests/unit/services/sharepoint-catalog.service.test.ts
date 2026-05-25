import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SharePointFileVersionIndex,
  SharePointFileVersionRecord,
  SharePointSnapshotManifest,
  SharePointManifestRepository,
  SharePointFileVersionIndexRepository,
  TenantContext,
  TenantContextFactory,
} from '@atlas/types';
import { SharePointCatalogService } from '@/services/sharepoint-catalog.service';

const TENANT_ID = 'tenant-1';
const SITE_ID = 'site-abc';

const ctx: TenantContext = {
  storage: {} as TenantContext['storage'],
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  create_cipher: vi.fn(),
} as unknown as TenantContext;

function make_snapshot(snapshot_id: string, total_files: number): SharePointSnapshotManifest {
  return {
    id: `${SITE_ID}-${snapshot_id}`,
    tenant_id: TENANT_ID,
    site_id: SITE_ID,
    snapshot_id,
    created_at: new Date('2026-01-15T10:00:00Z'),
    total_files,
    total_size_bytes: total_files * 1024,
    entries: [],
  };
}

function make_version(
  overrides: Partial<SharePointFileVersionRecord> = {},
): SharePointFileVersionRecord {
  return {
    snapshot_id: 'snap-1',
    backup_at: '2026-01-15T10:00:00Z',
    drive_id: 'drive-1',
    file_name: 'report.docx',
    parent_path: '/Shared Documents',
    size_bytes: 2048,
    change_type: 'created',
    ...overrides,
  };
}

function make_index(
  file_id: string,
  versions: SharePointFileVersionRecord[],
): SharePointFileVersionIndex {
  return { file_id, site_id: SITE_ID, versions };
}

function create_mocks() {
  const tenant_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(ctx),
  };

  const manifests: SharePointManifestRepository = {
    save: vi.fn(),
    find_by_snapshot: vi.fn(),
    find_latest_by_site: vi.fn(),
    list_snapshots_by_site: vi.fn().mockResolvedValue([]),
  } as unknown as SharePointManifestRepository;

  const indexes: SharePointFileVersionIndexRepository = {
    find_by_file_id: vi.fn().mockResolvedValue(undefined),
    append_version: vi.fn(),
    list_by_site: vi.fn().mockResolvedValue([]),
  } as unknown as SharePointFileVersionIndexRepository;

  return { tenant_factory, manifests, indexes };
}

describe('SharePointCatalogService', () => {
  let service: SharePointCatalogService;
  let mocks: ReturnType<typeof create_mocks>;

  beforeEach(() => {
    mocks = create_mocks();
    service = new SharePointCatalogService(
      mocks.tenant_factory as unknown as TenantContextFactory,
      mocks.manifests,
      mocks.indexes,
    );
  });

  describe('list_sharepoint_snapshots', () => {
    it('returns empty array when no snapshots exist', async () => {
      const result = await service.list_sharepoint_snapshots(TENANT_ID, SITE_ID);

      expect(result).toEqual([]);
      expect(mocks.tenant_factory.create).toHaveBeenCalledWith(TENANT_ID);
      expect(mocks.manifests.list_snapshots_by_site).toHaveBeenCalledWith(ctx, SITE_ID);
    });

    it('returns all snapshots from the manifest repository', async () => {
      const snaps = [make_snapshot('snap-2', 10), make_snapshot('snap-1', 5)];
      vi.mocked(mocks.manifests.list_snapshots_by_site).mockResolvedValue(snaps);

      const result = await service.list_sharepoint_snapshots(TENANT_ID, SITE_ID);

      expect(result).toHaveLength(2);
      expect(result[0].snapshot_id).toBe('snap-2');
      expect(result[1].snapshot_id).toBe('snap-1');
    });
  });

  describe('list_sharepoint_file_versions', () => {
    it('returns versions when file_ref is a known Graph item ID', async () => {
      const versions = [
        make_version({ snapshot_id: 'snap-1', change_type: 'created' }),
        make_version({ snapshot_id: 'snap-2', change_type: 'updated' }),
      ];
      const idx = make_index('file-abc', versions);
      vi.mocked(mocks.indexes.find_by_file_id).mockResolvedValue(idx);

      const result = await service.list_sharepoint_file_versions(TENANT_ID, SITE_ID, 'file-abc');

      expect(result).toHaveLength(2);
      expect(result[0].change_type).toBe('created');
      expect(result[1].change_type).toBe('updated');
    });

    it('returns empty array when Graph item ID is not found', async () => {
      vi.mocked(mocks.indexes.find_by_file_id).mockResolvedValue(undefined);

      const result = await service.list_sharepoint_file_versions(
        TENANT_ID,
        SITE_ID,
        'nonexistent-id',
      );

      expect(result).toEqual([]);
    });

    it('resolves file by path with forward slashes', async () => {
      const versions = [
        make_version({ parent_path: '/Shared Documents', file_name: 'report.docx' }),
      ];
      const idx = make_index('file-xyz', versions);
      vi.mocked(mocks.indexes.list_by_site).mockResolvedValue([idx]);
      vi.mocked(mocks.indexes.find_by_file_id).mockImplementation(async (_ctx, _site, fid) =>
        fid === 'file-xyz' ? idx : undefined,
      );

      const result = await service.list_sharepoint_file_versions(
        TENANT_ID,
        SITE_ID,
        '/Shared Documents/report.docx',
      );

      expect(result).toHaveLength(1);
      expect(result[0].file_name).toBe('report.docx');
    });

    it('resolves file by path with backslashes', async () => {
      const versions = [make_version({ parent_path: '/Documents', file_name: 'notes.txt' })];
      const idx = make_index('file-back', versions);
      vi.mocked(mocks.indexes.list_by_site).mockResolvedValue([idx]);
      vi.mocked(mocks.indexes.find_by_file_id).mockImplementation(async (_ctx, _site, fid) =>
        fid === 'file-back' ? idx : undefined,
      );

      const result = await service.list_sharepoint_file_versions(
        TENANT_ID,
        SITE_ID,
        '\\Documents\\notes.txt',
      );

      expect(result).toHaveLength(1);
      expect(result[0].file_name).toBe('notes.txt');
    });

    it('resolves file by path without leading slash', async () => {
      const versions = [make_version({ parent_path: '/Projects', file_name: 'plan.xlsx' })];
      const idx = make_index('file-noslash', versions);
      vi.mocked(mocks.indexes.list_by_site).mockResolvedValue([idx]);
      vi.mocked(mocks.indexes.find_by_file_id).mockImplementation(async (_ctx, _site, fid) =>
        fid === 'file-noslash' ? idx : undefined,
      );

      const result = await service.list_sharepoint_file_versions(
        TENANT_ID,
        SITE_ID,
        'Projects/plan.xlsx',
      );

      expect(result).toHaveLength(1);
    });

    it('returns empty when path does not match any indexed file', async () => {
      vi.mocked(mocks.indexes.list_by_site).mockResolvedValue([]);

      const result = await service.list_sharepoint_file_versions(
        TENANT_ID,
        SITE_ID,
        '/Unknown/file.txt',
      );

      expect(result).toEqual([]);
    });

    it('trims whitespace from file_ref before resolving', async () => {
      const versions = [make_version()];
      const idx = make_index('file-trimmed', versions);
      vi.mocked(mocks.indexes.find_by_file_id).mockResolvedValue(idx);

      const result = await service.list_sharepoint_file_versions(
        TENANT_ID,
        SITE_ID,
        '  file-trimmed  ',
      );

      expect(result).toHaveLength(1);
      expect(mocks.indexes.find_by_file_id).toHaveBeenCalledWith(ctx, SITE_ID, 'file-trimmed');
    });

    it('returns versions when index exists but has empty versions array', async () => {
      const idx = make_index('file-empty', []);
      vi.mocked(mocks.indexes.find_by_file_id).mockResolvedValue(idx);

      const result = await service.list_sharepoint_file_versions(TENANT_ID, SITE_ID, 'file-empty');

      expect(result).toEqual([]);
    });

    it('matches path with root parent_path correctly', async () => {
      const versions = [make_version({ parent_path: '/', file_name: 'root-file.pdf' })];
      const idx = make_index('file-root', versions);
      vi.mocked(mocks.indexes.list_by_site).mockResolvedValue([idx]);
      vi.mocked(mocks.indexes.find_by_file_id).mockImplementation(async (_ctx, _site, fid) =>
        fid === 'file-root' ? idx : undefined,
      );

      const result = await service.list_sharepoint_file_versions(
        TENANT_ID,
        SITE_ID,
        '/root-file.pdf',
      );

      expect(result).toHaveLength(1);
      expect(result[0].file_name).toBe('root-file.pdf');
    });

    it('scans multiple indexes to find matching path', async () => {
      const idx1 = make_index('file-a', [
        make_version({ parent_path: '/Docs', file_name: 'a.docx' }),
      ]);
      const idx2 = make_index('file-b', [
        make_version({ parent_path: '/Docs', file_name: 'b.docx' }),
      ]);
      vi.mocked(mocks.indexes.list_by_site).mockResolvedValue([idx1, idx2]);
      vi.mocked(mocks.indexes.find_by_file_id).mockImplementation(async (_ctx, _site, fid) => {
        if (fid === 'file-b') return idx2;
        return undefined;
      });

      const result = await service.list_sharepoint_file_versions(
        TENANT_ID,
        SITE_ID,
        '/Docs/b.docx',
      );

      expect(result).toHaveLength(1);
      expect(result[0].file_name).toBe('b.docx');
    });
  });
});
