import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { ArchiveDestinationError } from '@wisecom/atlas-core/services/shared/file-save-zip-writer';
import { add_file_to_archive } from '@wisecom/atlas-core/services/shared/file-save-zip-writer';
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
import { OneDriveSaveService } from '@/services/save/save.service';

/**
 * Issue #344: a consumer that disconnects mid-export takes the destination with it, and every
 * remaining entry was still downloaded and decrypted before its append failed. The run has nowhere
 * to put the bytes, so it stops at the first entry that cannot be written.
 */

vi.mock('@wisecom/atlas-core/services/shared/file-save-zip-writer', async (import_original) => {
  const actual =
    await import_original<
      typeof import('@wisecom/atlas-core/services/shared/file-save-zip-writer')
    >();
  const archive = {
    append: vi.fn(),
    finalize: vi.fn().mockResolvedValue(undefined),
    pointer: vi.fn().mockReturnValue(4096),
  };
  return {
    ...actual,
    create_file_archive: vi.fn().mockReturnValue({
      archive,
      promise: Promise.resolve(4096),
      drain: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    }),
    add_file_to_archive: vi.fn(),
    finalize_file_archive: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('@wisecom/atlas-core/utils/zone-identifier', () => ({
  mark_downloaded_from_internet: vi.fn().mockResolvedValue(undefined),
}));

const CONTENT = 'ciphertext';
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');

function make_entry(file_id: string): OneDriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name: `${file_id}.docx`,
    parent_path: '/Documents',
    size_bytes: 2048,
    change_type: 'updated',
    backup_at: '2026-03-15T10:00:00.000Z',
    storage_key: `onedrive/data/owner-1/${file_id}`,
    checksum: CHECKSUM,
  } as OneDriveManifestEntry;
}

function make_service(entries: OneDriveManifestEntry[]): {
  service: OneDriveSaveService;
  reads: () => string[];
} {
  const reads: string[] = [];
  const ctx = {
    storage: {
      get: vi.fn(async (key: string) => {
        reads.push(key);
        return Buffer.from(CONTENT);
      }),
      put: vi.fn(),
      exists: vi.fn(),
      delete: vi.fn(),
    },
    decrypt: vi.fn((buf: Buffer) => buf),
    encrypt: vi.fn((buf: Buffer) => buf),
    destroy: vi.fn(),
  } as unknown as TenantContext;

  const manifest: OneDriveSnapshotManifest = {
    id: 'manifest-od-1',
    tenant_id: 'tenant-1',
    snapshot_id: 'od-snap-1',
    owner_id: 'owner-1',
    created_at: new Date('2026-03-15T10:00:00Z'),
    total_files: entries.length,
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    entries,
  };

  const container = new Container();
  container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue({
    create: vi.fn().mockResolvedValue(ctx),
    create_readonly: vi.fn().mockResolvedValue(ctx),
    create_storage_only: vi.fn().mockResolvedValue(ctx),
  } as unknown as TenantContextFactory);
  container.bind(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN).toConstantValue({
    find_by_snapshot: vi.fn().mockResolvedValue(manifest),
    list_snapshots_by_owner: vi.fn().mockResolvedValue([manifest]),
  } as unknown as OneDriveManifestRepository);
  container.bind(OneDriveSaveService).toSelf();
  return { service: container.get(OneDriveSaveService), reads: () => reads };
}

describe('OneDrive save against a destination that went away (issue #344)', () => {
  beforeEach(() => {
    vi.mocked(add_file_to_archive).mockReset();
  });

  it('stops the run instead of downloading every remaining entry', async () => {
    const { service, reads } = make_service([
      make_entry('file-1'),
      make_entry('file-2'),
      make_entry('file-3'),
      make_entry('file-4'),
    ]);
    vi.mocked(add_file_to_archive)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new ArchiveDestinationError('The archive destination closed mid-entry'));

    await expect(
      service.save_snapshot('tenant-1', 'owner-1', {
        snapshot_id: 'od-snap-1',
        output_path: '/tmp/save.zip',
      }),
    ).rejects.toThrow(/destination closed/);

    // The first two were read, the second failed to append, and nothing after it was fetched.
    expect(reads()).toEqual(['onedrive/data/owner-1/file-1', 'onedrive/data/owner-1/file-2']);
  });

  it('still reports a single bad entry and carries on', async () => {
    const { service, reads } = make_service([make_entry('file-1'), make_entry('file-2')]);
    vi.mocked(add_file_to_archive)
      .mockRejectedValueOnce(new Error('one bad entry'))
      .mockResolvedValue(undefined);

    const result = await service.save_snapshot('tenant-1', 'owner-1', {
      snapshot_id: 'od-snap-1',
      output_path: '/tmp/save.zip',
    });

    expect(result.files_saved).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(reads()).toHaveLength(2);
  });
});
