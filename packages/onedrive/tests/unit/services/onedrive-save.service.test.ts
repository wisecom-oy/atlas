import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { OneDriveSaveService } from '@/services/onedrive-save.service';
import { ONEDRIVE_MANIFEST_REPOSITORY_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@atlas/types';
import type {
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@atlas/types';

vi.mock('@atlas/core/services/shared/file-save-zip-writer', () => {
  const mock_archive = {
    append: vi.fn(),
    finalize: vi.fn().mockResolvedValue(undefined),
    pointer: vi.fn().mockReturnValue(4096),
  };
  return {
    create_file_archive: vi.fn().mockReturnValue({
      archive: mock_archive,
      promise: Promise.resolve(4096),
    }),
    add_file_to_archive: vi.fn().mockResolvedValue(undefined),
    finalize_file_archive: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/services/onedrive-restore-streaming', () => ({
  should_stream_restore: vi.fn().mockReturnValue(false),
  stream_decrypt_from_storage: vi.fn(),
  verify_streaming_checksum: vi.fn().mockReturnValue(true),
}));

function make_entry(overrides: Partial<OneDriveManifestEntry> = {}): OneDriveManifestEntry {
  return {
    file_id: 'file-1',
    drive_id: 'drive-1',
    file_name: 'report.docx',
    parent_path: '/Documents',
    size_bytes: 2048,
    change_type: 'modified',
    backup_at: '2025-03-15T10:00:00.000Z',
    storage_key: 'onedrive/data/owner-1/abc123',
    checksum: '833183e24cabe9f5330eb37ab449543c4071217e490f7dd54a391923e676ab11',
    ...overrides,
  };
}

function make_manifest(
  entries: OneDriveManifestEntry[],
  overrides: Partial<OneDriveSnapshotManifest> = {},
): OneDriveSnapshotManifest {
  return {
    snapshot_id: 'od-snap-1',
    owner_id: 'owner-1',
    created_at: new Date('2025-03-15T10:00:00Z'),
    total_files: entries.length,
    entries,
    ...overrides,
  };
}

describe('OneDriveSaveService', () => {
  let container: Container;
  let mock_context: TenantContext;
  let mock_manifests: OneDriveManifestRepository;
  let service: OneDriveSaveService;

  beforeEach(() => {
    container = new Container();

    mock_context = {
      storage: {
        get: vi.fn().mockResolvedValue(Buffer.from('encrypted-content')),
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
    } as unknown as OneDriveManifestRepository;

    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(OneDriveSaveService).toSelf();

    service = container.get(OneDriveSaveService);
  });

  describe('save_snapshot', () => {
    it('saves files from a snapshot to a zip archive', async () => {
      const entries = [make_entry(), make_entry({ file_id: 'file-2', file_name: 'budget.xlsx' })];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'owner-1', {
        snapshot_id: 'od-snap-1',
        output_path: '/tmp/test-save.zip',
      });

      expect(result.snapshot_id).toBe('od-snap-1');
      expect(result.files_saved).toBe(2);
      expect(result.files_skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.output_path).toBe('/tmp/test-save.zip');
    });

    it('returns empty result when no restorable entries', async () => {
      const entries = [make_entry({ change_type: 'deleted', storage_key: undefined })];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'owner-1', {
        snapshot_id: 'od-snap-1',
      });

      expect(result.files_saved).toBe(0);
      expect(result.files_skipped).toBe(0);
    });

    it('throws when manifest not found', async () => {
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(undefined);

      await expect(
        service.save_snapshot('test-tenant', 'owner-1', { snapshot_id: 'od-snap-bad' }),
      ).rejects.toThrow('Snapshot od-snap-bad not found');
    });

    it('filters entries by file_filter', async () => {
      const entries = [
        make_entry({ file_id: 'file-1', file_name: 'report.docx' }),
        make_entry({ file_id: 'file-2', file_name: 'budget.xlsx' }),
      ];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'owner-1', {
        snapshot_id: 'od-snap-1',
        file_filter: ['file-1'],
        output_path: '/tmp/filtered.zip',
      });

      expect(result.files_saved).toBe(1);
    });

    it('skips files when decrypt fails', async () => {
      const entries = [make_entry()];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);
      vi.mocked(mock_context.storage.get).mockRejectedValue(new Error('S3 timeout'));

      const result = await service.save_snapshot('test-tenant', 'owner-1', {
        snapshot_id: 'od-snap-1',
        output_path: '/tmp/fail.zip',
      });

      expect(result.files_saved).toBe(0);
      expect(result.files_skipped).toBe(1);
    });

    it('generates default output path when not specified', async () => {
      const entries = [make_entry()];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'owner-1', {
        snapshot_id: 'od-snap-1',
      });

      expect(result.output_path).toMatch(/^onedrive-od-snap-1-/);
      expect(result.output_path).toMatch(/\.zip$/);
    });

    it('skips integrity check when skip_integrity_check is true', async () => {
      const entries = [make_entry({ checksum: 'wrong-checksum' })];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'owner-1', {
        snapshot_id: 'od-snap-1',
        skip_integrity_check: true,
        output_path: '/tmp/no-verify.zip',
      });

      expect(result.files_saved).toBe(1);
      expect(result.integrity_failures).toHaveLength(0);
    });
  });
});
