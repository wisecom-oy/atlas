import { createHash } from 'node:crypto';
import { apply_overrides, type Overrides } from '@wisecom/atlas-types/testing/apply-overrides';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  OneDriveFileVersionIndex,
  OneDriveFileVersionIndexRepository,
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { stub_encrypted_object_store } from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { OneDriveVerificationService } from '@/services/verification/verification.service';

const TENANT_ID = 'tenant-1';
const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const SNAPSHOT_ID = 'od-snap-2';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const CONTENT = Buffer.from('file-content');

function make_entry(overrides: Overrides<OneDriveManifestEntry> = {}): OneDriveManifestEntry {
  return apply_overrides<OneDriveManifestEntry>(
    {
      file_id: 'file-1',
      drive_id: 'drive-1',
      file_name: 'Report.docx',
      parent_path: '/Documents',
      size_bytes: CONTENT.length,
      storage_key: `onedrive/data/${OWNER_ID}/${sha256(CONTENT)}`,
      checksum: sha256(CONTENT),
      backup_at: new Date().toISOString(),
      change_type: 'created',
    },
    overrides,
  );
}

function make_manifest(
  entries: OneDriveManifestEntry[],
  snapshot_id = SNAPSHOT_ID,
  created_at = new Date('2026-03-02T00:00:00Z'),
): OneDriveSnapshotManifest {
  return {
    id: `${OWNER_ID}-${snapshot_id}`,
    tenant_id: TENANT_ID,
    owner_id: OWNER_ID,
    snapshot_id,
    created_at,
    total_files: entries.length,
    total_size_bytes: entries.reduce((sum, e) => sum + e.size_bytes, 0),
    entries,
  };
}

function make_index(file_id: string, snapshot_ids: string[]): OneDriveFileVersionIndex {
  return {
    file_id,
    owner_id: OWNER_ID,
    versions: snapshot_ids.map((snapshot_id) => ({
      snapshot_id,
      backup_at: new Date().toISOString(),
      drive_id: 'drive-1',
      file_name: 'Report.docx',
      parent_path: '/Documents',
      size_bytes: CONTENT.length,
      change_type: 'created' as const,
    })),
  };
}

function create_mocks() {
  const store = stub_encrypted_object_store();
  const stored = store.encrypt(CONTENT);

  const ctx: TenantContext = {
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

  const tenant_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(ctx),
    create_readonly: vi.fn().mockResolvedValue(ctx),
    create_storage_only: vi.fn().mockResolvedValue(ctx),
  };

  const manifests: OneDriveManifestRepository = {
    save: vi.fn(),
    find_by_snapshot: vi.fn(),
    find_latest_by_owner: vi.fn(),
    list_snapshots_by_owner: vi.fn().mockResolvedValue([]),
  } as unknown as OneDriveManifestRepository;

  const indexes: OneDriveFileVersionIndexRepository = {
    list_by_owner: vi.fn().mockResolvedValue([]),
  } as unknown as OneDriveFileVersionIndexRepository;

  return { ctx, tenant_factory, manifests, indexes, store };
}

describe('OneDriveVerificationService', () => {
  let service: OneDriveVerificationService;
  let mocks: ReturnType<typeof create_mocks>;

  beforeEach(() => {
    mocks = create_mocks();
    service = new OneDriveVerificationService(
      mocks.tenant_factory as unknown as TenantContextFactory,
      mocks.manifests,
      mocks.indexes,
    );
  });

  /** Replaces the bytes storage streams back for every object read. */
  const serve_object = (stored: Buffer): void => {
    vi.mocked(mocks.ctx.storage.get_stream as ReturnType<typeof vi.fn>).mockImplementation(
      async () => mocks.store.stream(stored),
    );
  };

  /** Points the repository at one manifest, as its own single-snapshot chain. */
  const given_snapshot = (entries: OneDriveManifestEntry[]): OneDriveSnapshotManifest => {
    const manifest = make_manifest(entries);
    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(manifest);
    vi.mocked(mocks.manifests.list_snapshots_by_owner).mockResolvedValue([manifest]);
    return manifest;
  };

  const verify = (): ReturnType<OneDriveVerificationService['verify_onedrive_snapshot']> =>
    service.verify_onedrive_snapshot(TENANT_ID, OWNER_ID, SNAPSHOT_ID);

  it('throws when no manifest is found', async () => {
    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(undefined);

    await expect(verify()).rejects.toThrow(/No OneDrive manifest found/);
  });

  it('returns all passed when blobs are intact and the index is consistent', async () => {
    const entry = make_entry();
    given_snapshot([entry]);
    vi.mocked(mocks.indexes.list_by_owner).mockResolvedValue([
      make_index(entry.file_id, [SNAPSHOT_ID]),
    ]);

    const result = await verify();

    expect(result.total_checked).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed_file_ids).toHaveLength(0);
    expect(result.index_issues).toHaveLength(0);
  });

  it('reports a mismatch when the stored content has a different checksum', async () => {
    const entry = make_entry();
    given_snapshot([entry]);
    vi.mocked(mocks.indexes.list_by_owner).mockResolvedValue([
      make_index(entry.file_id, [SNAPSHOT_ID]),
    ]);
    serve_object(mocks.store.encrypt(Buffer.from('tampered-content')));

    const result = await verify();

    expect(result.failed_file_ids).toContain(entry.file_id);
    expect(result.passed).toBe(0);
    expect(result.total_checked).toBe(1);
  });

  it('reports a blob that is absent from storage', async () => {
    const entry = make_entry();
    given_snapshot([entry]);
    vi.mocked(mocks.ctx.storage.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const result = await verify();

    expect(result.failed_file_ids).toContain(entry.file_id);
  });

  it('reports a blob whose ciphertext fails its auth tag', async () => {
    const entry = make_entry();
    given_snapshot([entry]);
    const corrupted = mocks.store.encrypt(CONTENT);
    corrupted[corrupted.length - 1] ^= 0xff;
    serve_object(corrupted);

    const result = await verify();

    expect(result.failed_file_ids).toContain(entry.file_id);
  });

  it('records an index issue when the file has no index at all', async () => {
    const entry = make_entry();
    given_snapshot([entry]);
    vi.mocked(mocks.indexes.list_by_owner).mockResolvedValue([]);

    const result = await verify();

    expect(result.index_issues.join(' ')).toContain(entry.file_id);
    // A missing index row is not a corrupt blob: the content still verified.
    expect(result.failed_file_ids).toHaveLength(0);
  });

  it('records an index issue when the index has no row for this snapshot', async () => {
    const entry = make_entry();
    given_snapshot([entry]);
    vi.mocked(mocks.indexes.list_by_owner).mockResolvedValue([
      make_index(entry.file_id, ['od-snap-unrelated']),
    ]);

    const result = await verify();

    expect(result.index_issues.join(' ')).toContain(SNAPSHOT_ID);
  });

  it('skips a deleted entry without reading an object', async () => {
    given_snapshot([make_entry({ change_type: 'deleted' })]);

    const result = await verify();

    expect(result.total_checked).toBe(0);
    expect(mocks.ctx.storage.get_stream).not.toHaveBeenCalled();
  });

  it('skips an entry with no storage key', async () => {
    given_snapshot([make_entry({ storage_key: undefined, checksum: undefined })]);

    const result = await verify();

    expect(result.total_checked).toBe(0);
    expect(mocks.ctx.storage.get_stream).not.toHaveBeenCalled();
  });

  it('counts mixed outcomes independently', async () => {
    const good = make_entry({ file_id: 'file-good' });
    const bad = make_entry({ file_id: 'file-bad', checksum: sha256(Buffer.from('other-bytes')) });
    const deleted = make_entry({
      file_id: 'file-del',
      change_type: 'deleted',
      storage_key: undefined,
      checksum: undefined,
    });
    given_snapshot([good, bad, deleted]);
    vi.mocked(mocks.indexes.list_by_owner).mockResolvedValue([
      make_index('file-good', [SNAPSHOT_ID]),
      make_index('file-bad', [SNAPSHOT_ID]),
      make_index('file-del', [SNAPSHOT_ID]),
    ]);

    const result = await verify();

    expect(result.total_checked).toBe(2);
    expect(result.failed_file_ids).toEqual(['file-bad']);
    expect(result.passed).toBe(1);
  });

  it('reports every blob failing as zero passed', async () => {
    given_snapshot([make_entry({ file_id: 'a' }), make_entry({ file_id: 'b' })]);
    vi.mocked(mocks.ctx.storage.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const result = await verify();

    expect(result.total_checked).toBe(2);
    expect(result.passed).toBe(0);
    expect(result.failed_file_ids).toEqual(['a', 'b']);
  });

  it('destroys the read-only context on the success path', async () => {
    given_snapshot([make_entry()]);

    await verify();

    expect(mocks.tenant_factory.create_readonly).toHaveBeenCalledWith(TENANT_ID);
    expect(mocks.ctx.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the context even when the run throws', async () => {
    given_snapshot([make_entry()]);
    vi.mocked(mocks.indexes.list_by_owner).mockRejectedValue(new Error('index read failed'));

    await expect(verify()).rejects.toThrow('index read failed');
    // Otherwise the tenant's key material stays in the heap until GC.
    expect(mocks.ctx.destroy).toHaveBeenCalledTimes(1);
  });
});
