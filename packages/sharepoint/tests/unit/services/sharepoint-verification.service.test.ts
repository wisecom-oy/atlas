/* eslint-disable @typescript-eslint/naming-convention */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SharePointManifestEntry,
  SharePointSnapshotManifest,
  SharePointFileVersionIndex,
  SharePointManifestRepository,
  SharePointFileVersionIndexRepository,
  TenantContext,
  TenantContextFactory,
} from '@atlas/types';
import { SharePointVerificationService } from '@/services/sharepoint-verification.service';

const TENANT_ID = 'tenant-1';
const SITE_ID = 'site-1';
const SNAPSHOT_ID = 'snap-1';

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function make_entry(overrides: Partial<SharePointManifestEntry> = {}): SharePointManifestEntry {
  const content = Buffer.from('file-content');
  return {
    file_id: 'file-1',
    drive_id: 'drive-1',
    file_name: 'doc.pdf',
    parent_path: '/Documents',
    size_bytes: content.length,
    storage_key: `sharepoint/data/${SITE_ID}/${sha256(content)}`,
    checksum: sha256(content),
    backup_at: new Date().toISOString(),
    change_type: 'created',
    ...overrides,
  };
}

function make_manifest(entries: SharePointManifestEntry[]): SharePointSnapshotManifest {
  return {
    id: `${SITE_ID}-${SNAPSHOT_ID}`,
    tenant_id: TENANT_ID,
    site_id: SITE_ID,
    snapshot_id: SNAPSHOT_ID,
    created_at: new Date(),
    total_files: entries.length,
    total_size_bytes: entries.reduce((sum, e) => sum + e.size_bytes, 0),
    entries,
  };
}

function make_index(file_id: string, has_snapshot: boolean): SharePointFileVersionIndex {
  return {
    file_id,
    site_id: SITE_ID,
    versions: has_snapshot
      ? [
          {
            snapshot_id: SNAPSHOT_ID,
            backup_at: new Date().toISOString(),
            drive_id: 'drive-1',
            file_name: 'doc.pdf',
            parent_path: '/Documents',
            size_bytes: 12,
            change_type: 'created',
          },
        ]
      : [],
  };
}

function create_mocks() {
  const plaintext = Buffer.from('file-content');
  const ciphertext = Buffer.from('encrypted-content');

  const ctx: TenantContext = {
    storage: {
      exists: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockResolvedValue(ciphertext),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      get_with_etag: vi.fn(),
    },
    encrypt: vi.fn().mockReturnValue(ciphertext),
    decrypt: vi.fn().mockReturnValue(plaintext),
    create_cipher: vi.fn(),
    destroy: vi.fn(),
  } as unknown as TenantContext;

  const tenant_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(ctx),
  };

  const manifests: SharePointManifestRepository = {
    save: vi.fn(),
    find_by_snapshot: vi.fn(),
    find_latest_by_site: vi.fn(),
    list_snapshots_by_site: vi.fn(),
  } as unknown as SharePointManifestRepository;

  const indexes: SharePointFileVersionIndexRepository = {
    find_by_file_id: vi.fn(),
    append_version: vi.fn(),
    list_by_site: vi.fn(),
  } as unknown as SharePointFileVersionIndexRepository;

  return { ctx, tenant_factory, manifests, indexes };
}

describe('SharePointVerificationService', () => {
  let service: SharePointVerificationService;
  let mocks: ReturnType<typeof create_mocks>;

  beforeEach(() => {
    mocks = create_mocks();
    service = new SharePointVerificationService(
      mocks.tenant_factory as unknown as TenantContextFactory,
      mocks.manifests,
      mocks.indexes,
    );
  });

  it('throws when no manifest is found', async () => {
    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(undefined);

    await expect(
      service.verify_sharepoint_snapshot(TENANT_ID, SITE_ID, SNAPSHOT_ID),
    ).rejects.toThrow(/No SharePoint manifest found/);
  });

  it('returns all passed when blobs are intact and indexes are consistent', async () => {
    const entry = make_entry();
    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(make_manifest([entry]));
    vi.mocked(mocks.indexes.find_by_file_id).mockResolvedValue(make_index(entry.file_id, true));

    const result = await service.verify_sharepoint_snapshot(TENANT_ID, SITE_ID, SNAPSHOT_ID);

    expect(result.total_checked).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed_file_ids).toHaveLength(0);
    expect(result.index_issues).toHaveLength(0);
  });

  it('reports blob mismatch when decrypted content has wrong checksum', async () => {
    const entry = make_entry();
    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(make_manifest([entry]));
    vi.mocked(mocks.indexes.find_by_file_id).mockResolvedValue(make_index(entry.file_id, true));
    vi.mocked(mocks.ctx.decrypt).mockReturnValue(Buffer.from('tampered-content'));

    const result = await service.verify_sharepoint_snapshot(TENANT_ID, SITE_ID, SNAPSHOT_ID);

    expect(result.failed_file_ids).toContain(entry.file_id);
    expect(result.passed).toBe(0);
  });

  it('reports blob corrupt when storage.exists returns false', async () => {
    const entry = make_entry();
    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(make_manifest([entry]));
    vi.mocked(mocks.indexes.find_by_file_id).mockResolvedValue(make_index(entry.file_id, true));
    vi.mocked(mocks.ctx.storage.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const result = await service.verify_sharepoint_snapshot(TENANT_ID, SITE_ID, SNAPSHOT_ID);

    expect(result.failed_file_ids).toContain(entry.file_id);
  });

  it('reports index issue when file version index is missing', async () => {
    const entry = make_entry();
    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(make_manifest([entry]));
    vi.mocked(mocks.indexes.find_by_file_id).mockResolvedValue(undefined);

    const result = await service.verify_sharepoint_snapshot(TENANT_ID, SITE_ID, SNAPSHOT_ID);

    expect(result.index_issues).toHaveLength(1);
    expect(result.index_issues[0]).toContain('missing index version');
  });

  it('reports index issue when index has no record for this snapshot', async () => {
    const entry = make_entry();
    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(make_manifest([entry]));
    vi.mocked(mocks.indexes.find_by_file_id).mockResolvedValue(make_index(entry.file_id, false));

    const result = await service.verify_sharepoint_snapshot(TENANT_ID, SITE_ID, SNAPSHOT_ID);

    expect(result.index_issues).toHaveLength(1);
  });

  it('skips blob check for deleted entries', async () => {
    const entry = make_entry({
      change_type: 'deleted',
      storage_key: undefined,
      checksum: undefined,
    });
    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(make_manifest([entry]));
    vi.mocked(mocks.indexes.find_by_file_id).mockResolvedValue(make_index(entry.file_id, true));

    const result = await service.verify_sharepoint_snapshot(TENANT_ID, SITE_ID, SNAPSHOT_ID);

    expect(result.total_checked).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed_file_ids).toHaveLength(0);
  });

  it('skips blob check for entries without storage key', async () => {
    const entry = make_entry({ storage_key: undefined, checksum: undefined });
    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(make_manifest([entry]));
    vi.mocked(mocks.indexes.find_by_file_id).mockResolvedValue(make_index(entry.file_id, true));

    const result = await service.verify_sharepoint_snapshot(TENANT_ID, SITE_ID, SNAPSHOT_ID);

    expect(result.total_checked).toBe(0);
    expect(result.failed_file_ids).toHaveLength(0);
  });

  it('reports blob corrupt when decrypt throws', async () => {
    const entry = make_entry();
    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(make_manifest([entry]));
    vi.mocked(mocks.indexes.find_by_file_id).mockResolvedValue(make_index(entry.file_id, true));
    vi.mocked(mocks.ctx.decrypt).mockImplementation(() => {
      throw new Error('decryption failed');
    });

    const result = await service.verify_sharepoint_snapshot(TENANT_ID, SITE_ID, SNAPSHOT_ID);

    expect(result.failed_file_ids).toContain(entry.file_id);
  });

  it('handles multiple entries with mixed outcomes', async () => {
    const good_content = Buffer.from('good-data');
    const good_entry = make_entry({
      file_id: 'file-good',
      checksum: sha256(good_content),
    });
    const bad_entry = make_entry({ file_id: 'file-bad' });
    const deleted_entry = make_entry({
      file_id: 'file-del',
      change_type: 'deleted',
      storage_key: undefined,
      checksum: undefined,
    });

    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(
      make_manifest([good_entry, bad_entry, deleted_entry]),
    );

    vi.mocked(mocks.indexes.find_by_file_id).mockImplementation(async (_ctx, _site, file_id) => {
      if (file_id === 'file-del') return make_index(file_id, true);
      if (file_id === 'file-good') return make_index(file_id, true);
      return undefined;
    });

    vi.mocked(mocks.ctx.decrypt).mockImplementation((ciphertext: Buffer) => {
      return good_content;
    });

    const result = await service.verify_sharepoint_snapshot(TENANT_ID, SITE_ID, SNAPSHOT_ID);

    expect(result.total_checked).toBe(2);
    expect(result.index_issues.length).toBeGreaterThanOrEqual(1);
  });
});
