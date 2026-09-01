import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { OneDriveSaveService } from '@/services/save/save.service';
import {
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';

/** Fixture overrides may blank an optional field; an explicit `undefined` drops the key. */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

function apply_overrides<T extends object>(base: T, overrides: Overrides<T>): T {
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
  }
  return merged as T;
}

vi.mock('@wisecom/atlas-core/services/shared/file-save-zip-writer', () => {
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

vi.mock('@/services/restore/restore-streaming', () => ({
  should_stream_restore: vi.fn().mockReturnValue(false),
  stream_decrypt_from_storage: vi.fn(),
  verify_streaming_checksum: vi.fn().mockReturnValue(true),
}));

function make_entry(overrides: Overrides<OneDriveManifestEntry> = {}): OneDriveManifestEntry {
  const base: OneDriveManifestEntry = {
    file_id: 'file-1',
    drive_id: 'drive-1',
    file_name: 'report.docx',
    parent_path: '/Documents',
    size_bytes: 2048,
    change_type: 'updated',
    backup_at: '2025-03-15T10:00:00.000Z',
    storage_key: 'onedrive/data/owner-1/abc123',
    checksum: '833183e24cabe9f5330eb37ab449543c4071217e490f7dd54a391923e676ab11',
  };
  return apply_overrides(base, overrides);
}

function make_manifest(
  entries: OneDriveManifestEntry[],
  overrides: Overrides<OneDriveSnapshotManifest> = {},
): OneDriveSnapshotManifest {
  const base: OneDriveSnapshotManifest = {
    id: 'manifest-od-1',
    tenant_id: 'tenant-1',
    snapshot_id: 'od-snap-1',
    owner_id: 'owner-1',
    total_size_bytes: entries.reduce((sum, e) => sum + e.size_bytes, 0),
    created_at: new Date('2025-03-15T10:00:00Z'),
    total_files: entries.length,
    entries,
  };
  return apply_overrides(base, overrides);
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
      destroy: vi.fn(),
    } as unknown as TenantContext;

    const mock_factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(mock_context),
      create_readonly: vi.fn().mockResolvedValue(mock_context),
      create_storage_only: vi.fn().mockResolvedValue(mock_context),
    };

    mock_manifests = {
      find_by_snapshot: vi.fn(),
      list_snapshots_by_owner: vi.fn().mockResolvedValue([]),
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

    // #173: a delta snapshot lists only what changed, so an export that reads one manifest loses
    // every file whose last change was an earlier run.
    it('exports a file carried over from an older snapshot', async () => {
      const newest = make_manifest([make_entry({ file_id: 'file-1', file_name: 'report.docx' })], {
        snapshot_id: 'od-snap-2',
        created_at: new Date('2025-03-16T10:00:00Z'),
      });
      const older = make_manifest([make_entry({ file_id: 'file-2', file_name: 'budget.xlsx' })]);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(newest);
      vi.mocked(mock_manifests.list_snapshots_by_owner).mockResolvedValue([newest, older]);

      const result = await service.save_snapshot('test-tenant', 'owner-1', {
        snapshot_id: 'od-snap-2',
        output_path: '/tmp/test-save.zip',
      });

      expect(result.files_saved).toBe(2);
    });

    it('does not export a file the newest snapshot records as deleted', async () => {
      const newest = make_manifest(
        [make_entry({ file_id: 'file-2', change_type: 'deleted', storage_key: undefined })],
        { snapshot_id: 'od-snap-2', created_at: new Date('2025-03-16T10:00:00Z') },
      );
      const older = make_manifest([make_entry({ file_id: 'file-2', file_name: 'budget.xlsx' })]);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(newest);
      vi.mocked(mock_manifests.list_snapshots_by_owner).mockResolvedValue([newest, older]);

      const result = await service.save_snapshot('test-tenant', 'owner-1', {
        snapshot_id: 'od-snap-2',
        output_path: '/tmp/test-save.zip',
      });

      expect(result.files_saved).toBe(0);
    });

    it('ignores snapshots newer than the one being exported', async () => {
      const target = make_manifest([make_entry({ file_id: 'file-1' })]);
      const newer = make_manifest([make_entry({ file_id: 'file-9', file_name: 'later.docx' })], {
        snapshot_id: 'od-snap-9',
        created_at: new Date('2025-04-01T10:00:00Z'),
      });
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(target);
      vi.mocked(mock_manifests.list_snapshots_by_owner).mockResolvedValue([newer, target]);

      const result = await service.save_snapshot('test-tenant', 'owner-1', {
        snapshot_id: 'od-snap-1',
        output_path: '/tmp/test-save.zip',
      });

      expect(result.files_saved).toBe(1);
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
      ).rejects.toThrow('No OneDrive manifest found for snapshot od-snap-bad');
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

    it('stops between files and returns partial counts when interrupted', async () => {
      const manifest = make_manifest([
        make_entry(),
        make_entry({ file_id: 'file-2', file_name: 'budget.xlsx' }),
      ]);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);
      let interrupted = false;
      vi.mocked(mock_context.storage.get).mockImplementation(async () => {
        interrupted = true;
        return Buffer.from('encrypted-content');
      });
      const on_progress = vi.fn();

      const result = await service.save_snapshot('test-tenant', 'owner-1', {
        snapshot_id: 'od-snap-1',
        output_path: '/tmp/interrupted.zip',
        should_interrupt: () => interrupted,
        on_progress,
      });

      expect(mock_context.storage.get).toHaveBeenCalledOnce();
      expect(result.files_saved).toBe(1);
      expect(result.interrupted).toBe(true);
      expect(on_progress).toHaveBeenLastCalledWith(
        expect.objectContaining({ operation: 'save', workload: 'onedrive', phase: 'interrupted' }),
      );
    });
  });
});
