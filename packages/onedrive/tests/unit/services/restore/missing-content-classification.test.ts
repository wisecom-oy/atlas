/**
 * Issue #358. A manifest entry pointing at content that is no longer in storage was a silent
 * skip on OneDrive and a recorded error on SharePoint, so the identical event exited 2 on one
 * provider and 1 on the other, with no per-file reason printed on OneDrive.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');

function make_entry(file_id: string): OneDriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name: `${file_id}.txt`,
    parent_path: '/Projects',
    size_bytes: CONTENT.length,
    change_type: 'updated',
    backup_at: '2026-08-17T00:00:00.000Z',
    storage_key: `onedrive/data/${file_id}`,
    checksum: CHECKSUM,
  } as OneDriveManifestEntry;
}

function make_service(missing: ReadonlySet<string>): OneDriveRestoreService {
  const entries = [make_entry('file-1'), make_entry('file-2')];
  const manifest = {
    id: 'manifest-1',
    tenant_id: 'tenant-1',
    snapshot_id: 'snap-1',
    owner_id: 'owner-1',
    created_at: new Date('2026-08-17T00:00:00.000Z'),
    total_files: entries.length,
    total_size_bytes: entries.length * CONTENT.length,
    entries,
  } as OneDriveSnapshotManifest;

  const ctx = {
    tenant_id: 'tenant-1',
    storage: {
      get: vi.fn(async (key: string) => {
        if (missing.has(key)) throw new Error('NoSuchKey');
        return CONTENT;
      }),
    },
    encrypt: vi.fn((data: Buffer) => data),
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
    create_folder: vi.fn().mockImplementation(async () => `folder-${++folder_seq}`),
    upload_small_file: vi.fn().mockResolvedValue(undefined),
    upload_large_file: vi.fn().mockResolvedValue(undefined),
  } as unknown as OneDriveConnector;

  const manifests = {
    find_by_snapshot: vi.fn().mockResolvedValue(manifest),
    list_snapshots_by_owner: vi.fn().mockResolvedValue([]),
  } as unknown as OneDriveManifestRepository;

  return new OneDriveRestoreService(factory, connector, manifests);
}

describe('OneDrive restore with content missing from storage', () => {
  it('records a per-file reason instead of skipping silently', async () => {
    const service = make_service(new Set(['onedrive/data/file-1']));

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
    });

    expect(result.files_skipped).toBe(1);
    expect(result.files_restored).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('file-1.txt');
  });

  it('reports nothing for a restore where every blob is present', async () => {
    const service = make_service(new Set());

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
    });

    expect(result.files_restored).toBe(2);
    expect(result.errors).toEqual([]);
  });
});
