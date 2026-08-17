import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  OneDriveConnector,
  OneDriveFileVersionIndexRepository,
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveRestoreService } from '@/services/onedrive-restore.service';
import { OneDriveVerificationService } from '@/services/onedrive-verification.service';

const CONTENT = Buffer.from('file-content');
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');

function make_entry(file_id: string): OneDriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name: `${file_id}.txt`,
    parent_path: '/',
    size_bytes: CONTENT.length,
    change_type: 'updated',
    backup_at: '2026-08-17T00:00:00.000Z',
    storage_key: `onedrive/data/${file_id}`,
    checksum: CHECKSUM,
  };
}

function make_manifest(): OneDriveSnapshotManifest {
  const entries = [make_entry('file-1'), make_entry('file-2')];
  return {
    id: 'manifest-1',
    tenant_id: 'tenant-1',
    snapshot_id: 'snap-1',
    owner_id: 'owner-1',
    created_at: new Date('2026-08-17T00:00:00.000Z'),
    total_files: entries.length,
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    entries,
  };
}

function make_context(storage: TenantContext['storage']): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage,
    encrypt: vi.fn((data: Buffer) => data),
    decrypt: vi.fn((data: Buffer) => data),
    create_cipher: vi.fn(),
    create_decipher: vi.fn(),
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

function make_manifest_repository(manifest: OneDriveSnapshotManifest): OneDriveManifestRepository {
  return {
    find_by_snapshot: vi.fn().mockResolvedValue(manifest),
  } as unknown as OneDriveManifestRepository;
}

describe('OneDrive operation cancellation', () => {
  it('restore finishes the current file then stops with partial counts', async () => {
    let interrupted = false;
    const storage = {
      get: vi.fn().mockImplementation(async () => {
        interrupted = true;
        return CONTENT;
      }),
    } as unknown as TenantContext['storage'];
    const context = make_context(storage);
    const factory = {
      create: vi.fn().mockResolvedValue(context),
    } as unknown as TenantContextFactory;
    const connector = {
      list_drives: vi.fn().mockResolvedValue([{ drive_id: 'drive-1', drive_name: 'Documents' }]),
      upload_small_file: vi.fn().mockResolvedValue(undefined),
    } as unknown as OneDriveConnector;
    const on_progress = vi.fn();
    const service = new OneDriveRestoreService(
      factory,
      connector,
      make_manifest_repository(make_manifest()),
    );

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      should_interrupt: () => interrupted,
      on_progress,
    });

    expect(connector.upload_small_file).toHaveBeenCalledOnce();
    expect(result.files_restored).toBe(1);
    expect(result.interrupted).toBe(true);
    expect(on_progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'restore', workload: 'onedrive', phase: 'interrupted' }),
    );
  });

  it('verify does not start index or blob reads after cancellation', async () => {
    const storage = {
      exists: vi.fn(),
      get: vi.fn(),
    } as unknown as TenantContext['storage'];
    const context = make_context(storage);
    const factory = {
      create: vi.fn().mockResolvedValue(context),
    } as unknown as TenantContextFactory;
    const indexes = { find_by_file_id: vi.fn() } as unknown as OneDriveFileVersionIndexRepository;
    const on_progress = vi.fn();
    const service = new OneDriveVerificationService(
      factory,
      make_manifest_repository(make_manifest()),
      indexes,
    );

    const result = await service.verify_onedrive_snapshot('tenant-1', 'owner-1', 'snap-1', {
      should_interrupt: () => true,
      on_progress,
    });

    expect(indexes.find_by_file_id).not.toHaveBeenCalled();
    expect(storage.exists).not.toHaveBeenCalled();
    expect(result.total_checked).toBe(0);
    expect(result.interrupted).toBe(true);
    expect(on_progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'verify', workload: 'onedrive', phase: 'interrupted' }),
    );
  });
});
