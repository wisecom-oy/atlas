import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { SharePointSaveService } from '@/services/sharepoint-save.service';
import { SHAREPOINT_MANIFEST_REPOSITORY_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@atlas/types';
import type {
  SharePointManifestEntry,
  SharePointManifestRepository,
  SharePointSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@atlas/types';

vi.mock('@atlas/core/services/shared/file-save-zip-writer', () => {
  const mock_archive = {
    append: vi.fn(),
    finalize: vi.fn().mockResolvedValue(undefined),
    pointer: vi.fn().mockReturnValue(8192),
  };
  return {
    create_file_archive: vi.fn().mockReturnValue({
      archive: mock_archive,
      promise: Promise.resolve(8192),
    }),
    add_file_to_archive: vi.fn().mockResolvedValue(undefined),
    finalize_file_archive: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/services/sharepoint-restore-streaming', () => ({
  should_stream_restore: vi.fn().mockReturnValue(false),
  stream_decrypt_from_storage: vi.fn(),
  verify_streaming_checksum: vi.fn().mockReturnValue(true),
}));

function make_entry(overrides: Partial<SharePointManifestEntry> = {}): SharePointManifestEntry {
  return {
    file_id: 'sp-file-1',
    drive_id: 'lib-1',
    file_name: 'proposal.pptx',
    parent_path: '/Shared Documents',
    size_bytes: 4096,
    change_type: 'modified',
    backup_at: '2025-03-15T10:00:00.000Z',
    storage_key: 'sharepoint/data/site-1/def456',
    checksum: '0398517bbb3279028c12e29443c51d33698a9aca40da07df68da5a138c8325a7',
    ...overrides,
  };
}

function make_manifest(
  entries: SharePointManifestEntry[],
  overrides: Partial<SharePointSnapshotManifest> = {},
): SharePointSnapshotManifest {
  return {
    snapshot_id: 'sp-snap-1',
    site_id: 'site-1',
    created_at: new Date('2025-03-15T10:00:00Z'),
    total_files: entries.length,
    entries,
    ...overrides,
  };
}

describe('SharePointSaveService', () => {
  let container: Container;
  let mock_context: TenantContext;
  let mock_manifests: SharePointManifestRepository;
  let service: SharePointSaveService;

  beforeEach(() => {
    container = new Container();

    mock_context = {
      storage: {
        get: vi.fn().mockResolvedValue(Buffer.from('encrypted-sp-content')),
        put: vi.fn(),
        exists: vi.fn(),
        delete: vi.fn(),
      },
      decrypt: vi.fn((buf: Buffer) => buf),
      encrypt: vi.fn((buf: Buffer) => buf),
    } as unknown as TenantContext;

    const mock_factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(mock_context),
    };

    mock_manifests = {
      find_by_snapshot: vi.fn(),
      list_manifests: vi.fn().mockResolvedValue([]),
      save_manifest: vi.fn(),
    } as unknown as SharePointManifestRepository;

    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(SharePointSaveService).toSelf();

    service = container.get(SharePointSaveService);
  });

  describe('save_snapshot', () => {
    it('saves files from a snapshot to a zip archive', async () => {
      const entries = [
        make_entry(),
        make_entry({ file_id: 'sp-file-2', file_name: 'report.docx' }),
      ];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'site-1', {
        snapshot_id: 'sp-snap-1',
        output_path: '/tmp/sp-test-save.zip',
      });

      expect(result.snapshot_id).toBe('sp-snap-1');
      expect(result.files_saved).toBe(2);
      expect(result.files_skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.output_path).toBe('/tmp/sp-test-save.zip');
    });

    it('returns empty result when no restorable entries', async () => {
      const entries = [make_entry({ change_type: 'deleted', storage_key: undefined })];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'site-1', {
        snapshot_id: 'sp-snap-1',
      });

      expect(result.files_saved).toBe(0);
      expect(result.files_skipped).toBe(0);
    });

    it('throws when manifest not found', async () => {
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(undefined);

      await expect(
        service.save_snapshot('test-tenant', 'site-1', { snapshot_id: 'sp-snap-bad' }),
      ).rejects.toThrow('Snapshot sp-snap-bad not found');
    });

    it('filters entries by file_filter (file ID)', async () => {
      const entries = [
        make_entry({ file_id: 'sp-file-1', file_name: 'proposal.pptx' }),
        make_entry({ file_id: 'sp-file-2', file_name: 'report.docx' }),
      ];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'site-1', {
        snapshot_id: 'sp-snap-1',
        file_filter: ['sp-file-1'],
        output_path: '/tmp/filtered.zip',
      });

      expect(result.files_saved).toBe(1);
    });

    it('filters entries by file_filter (full path, case-insensitive)', async () => {
      const entries = [
        make_entry({ file_id: 'sp-file-1', parent_path: '/Docs', file_name: 'A.xlsx' }),
        make_entry({ file_id: 'sp-file-2', parent_path: '/Docs', file_name: 'B.xlsx' }),
      ];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'site-1', {
        snapshot_id: 'sp-snap-1',
        file_filter: ['/docs/a.xlsx'],
        output_path: '/tmp/path-filter.zip',
      });

      expect(result.files_saved).toBe(1);
    });

    it('skips files when S3 download fails', async () => {
      const entries = [make_entry()];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);
      vi.mocked(mock_context.storage.get).mockRejectedValue(new Error('S3 unavailable'));

      const result = await service.save_snapshot('test-tenant', 'site-1', {
        snapshot_id: 'sp-snap-1',
        output_path: '/tmp/fail.zip',
      });

      expect(result.files_saved).toBe(0);
      expect(result.files_skipped).toBe(1);
    });

    it('generates default output path when not specified', async () => {
      const entries = [make_entry()];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'site-1', {
        snapshot_id: 'sp-snap-1',
      });

      expect(result.output_path).toMatch(/^sharepoint-sp-snap-1-/);
      expect(result.output_path).toMatch(/\.zip$/);
    });

    it('skips integrity check when skip_integrity_check is true', async () => {
      const entries = [make_entry({ checksum: 'wrong-checksum' })];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'site-1', {
        snapshot_id: 'sp-snap-1',
        skip_integrity_check: true,
        output_path: '/tmp/no-verify.zip',
      });

      expect(result.files_saved).toBe(1);
      expect(result.integrity_failures).toHaveLength(0);
    });

    it('excludes deleted entries and entries without storage_key', async () => {
      const entries = [
        make_entry({ file_id: 'f-live', change_type: 'modified' }),
        make_entry({ file_id: 'f-del', change_type: 'deleted' }),
        make_entry({ file_id: 'f-nokey', change_type: 'created', storage_key: undefined }),
      ];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'site-1', {
        snapshot_id: 'sp-snap-1',
        output_path: '/tmp/exclude.zip',
      });

      expect(result.files_saved).toBe(1);
    });
  });
});
