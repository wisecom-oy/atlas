import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  OneDriveFileVersionIndexRepository,
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveVerificationResult,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { stub_encrypted_object_store } from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { OneDriveVerificationService } from '@/services/verification/verification.service';

/**
 * Issue #341: verification required a checksum before it would look at an entry, so an entry that
 * named a blob but recorded no checksum was excluded from `total_checked` entirely. A snapshot of
 * those verified clean without a single byte being read.
 */

const TENANT_ID = 'tenant-1';
const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const SNAPSHOT_ID = 'od-snap-1';
const CONTENT = Buffer.from('file-content');
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');

function make_entry(overrides: Record<string, unknown> = {}): OneDriveManifestEntry {
  return {
    file_id: 'file-1',
    drive_id: 'drive-1',
    file_name: 'Report.docx',
    parent_path: '/Documents',
    size_bytes: CONTENT.length,
    storage_key: `onedrive/data/${OWNER_ID}/${CHECKSUM}`,
    checksum: CHECKSUM,
    backup_at: new Date().toISOString(),
    change_type: 'created',
    ...overrides,
  } as OneDriveManifestEntry;
}

function make_service(entries: OneDriveManifestEntry[]): OneDriveVerificationService {
  const store = stub_encrypted_object_store();
  const stored = store.encrypt(CONTENT);
  const ctx = {
    storage: {
      exists: vi.fn().mockResolvedValue(true),
      get_stream: vi.fn().mockImplementation(async () => store.stream(stored)),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      get_with_etag: vi.fn(),
    },
    encrypt: vi.fn().mockReturnValue(stored),
    create_decipher: vi.fn().mockImplementation(store.create_decipher),
    create_cipher: vi.fn(),
    destroy: vi.fn(),
  } as unknown as TenantContext;

  const manifest: OneDriveSnapshotManifest = {
    id: `${OWNER_ID}-${SNAPSHOT_ID}`,
    tenant_id: TENANT_ID,
    owner_id: OWNER_ID,
    snapshot_id: SNAPSHOT_ID,
    created_at: new Date('2026-03-02T00:00:00Z'),
    total_files: entries.length,
    total_size_bytes: entries.reduce((sum, e) => sum + e.size_bytes, 0),
    entries,
  };

  const tenant_factory = {
    create: vi.fn().mockResolvedValue(ctx),
    create_readonly: vi.fn().mockResolvedValue(ctx),
    create_storage_only: vi.fn().mockResolvedValue(ctx),
  } as unknown as TenantContextFactory;
  const manifests = {
    find_by_snapshot: vi.fn().mockResolvedValue(manifest),
    list_snapshots_by_owner: vi.fn().mockResolvedValue([manifest]),
    find_latest_by_owner: vi.fn(),
    save: vi.fn(),
  } as unknown as OneDriveManifestRepository;
  const indexes = {
    list_by_owner: vi.fn().mockResolvedValue([]),
  } as unknown as OneDriveFileVersionIndexRepository;

  return new OneDriveVerificationService(tenant_factory, manifests, indexes);
}

describe('verification of an entry with no checksum (issue #341)', () => {
  let result: OneDriveVerificationResult;

  beforeEach(async () => {
    const service = make_service([make_entry({ checksum: undefined })]);
    result = await service.verify_onedrive_snapshot(TENANT_ID, OWNER_ID, SNAPSHOT_ID);
  });

  it('counts the entry rather than excluding it from the run', () => {
    expect(result.total_checked).toBe(1);
  });

  it('reports it as failed, because nothing can prove the stored bytes are the file', () => {
    expect(result.failed_file_ids).toEqual(['file-1']);
    expect(result.passed).toBe(0);
  });
});

describe('verification of a deleted entry (issue #341)', () => {
  it('still excludes a tombstone, which has no blob to verify', async () => {
    const service = make_service([
      make_entry({ change_type: 'deleted', storage_key: undefined, checksum: undefined }),
    ]);

    const result = await service.verify_onedrive_snapshot(TENANT_ID, OWNER_ID, SNAPSHOT_ID);

    expect(result.total_checked).toBe(0);
    expect(result.failed_file_ids).toEqual([]);
  });
});
