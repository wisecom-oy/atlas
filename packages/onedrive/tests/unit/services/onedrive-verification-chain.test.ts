import { createHash } from 'node:crypto';
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
import { OneDriveVerificationService } from '@/services/onedrive-verification.service';

// Issue #173: verification walks the manifest chain, and a carried-over file
// has its index row under the snapshot that recorded it. Both rules are
// invisible in a single-snapshot fixture, which is how the original defect
// reported carried-over files as checked when they were never read.

const TENANT_ID = 'tenant-1';
const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const OLDER = 'od-snap-1';
const TARGET = 'od-snap-2';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const CONTENT = Buffer.from('file-content');

function make_entry(file_id: string, file_name: string): OneDriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name,
    parent_path: '/Documents',
    size_bytes: CONTENT.length,
    storage_key: `onedrive/data/${OWNER_ID}/${sha256(CONTENT)}`,
    checksum: sha256(CONTENT),
    backup_at: new Date().toISOString(),
    change_type: 'created',
  };
}

function make_manifest(
  snapshot_id: string,
  created_at: string,
  entries: OneDriveManifestEntry[],
): OneDriveSnapshotManifest {
  return {
    id: `${OWNER_ID}-${snapshot_id}`,
    tenant_id: TENANT_ID,
    owner_id: OWNER_ID,
    snapshot_id,
    created_at: new Date(created_at),
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
  const read_keys: string[] = [];

  const ctx: TenantContext = {
    storage: {
      exists: vi.fn().mockResolvedValue(true),
      get_stream: vi.fn().mockImplementation(async (key: string) => {
        read_keys.push(key);
        return store.stream(stored);
      }),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      get_with_etag: vi.fn(),
    },
    encrypt: vi.fn(),
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

  return { ctx, tenant_factory, manifests, indexes, read_keys };
}

describe('OneDriveVerificationService chain rules (issue #173)', () => {
  let service: OneDriveVerificationService;
  let mocks: ReturnType<typeof create_mocks>;

  /** `carried` last changed in OLDER; `fresh` changed in TARGET. */
  const carried = make_entry('file-carried', 'Carried.docx');
  const fresh = make_entry('file-fresh', 'Fresh.docx');

  beforeEach(() => {
    mocks = create_mocks();
    service = new OneDriveVerificationService(
      mocks.tenant_factory as unknown as TenantContextFactory,
      mocks.manifests,
      mocks.indexes,
    );

    const older = make_manifest(OLDER, '2026-03-01T00:00:00Z', [carried]);
    const target = make_manifest(TARGET, '2026-03-02T00:00:00Z', [fresh]);
    vi.mocked(mocks.manifests.find_by_snapshot).mockResolvedValue(target);
    vi.mocked(mocks.manifests.list_snapshots_by_owner).mockResolvedValue([target, older]);
  });

  const verify = (): ReturnType<OneDriveVerificationService['verify_onedrive_snapshot']> =>
    service.verify_onedrive_snapshot(TENANT_ID, OWNER_ID, TARGET);

  it('verifies a file inherited from an earlier snapshot in the chain', async () => {
    vi.mocked(mocks.indexes.list_by_owner).mockResolvedValue([
      make_index('file-fresh', [TARGET]),
      make_index('file-carried', [OLDER]),
    ]);

    const result = await verify();

    // Two entries, though the target manifest lists only one: verifying the
    // target alone would report the carried file as checked without reading it.
    expect(result.total_checked).toBe(2);
    expect(result.passed).toBe(2);
    expect(mocks.read_keys).toHaveLength(2);
  });

  it('looks an index row up against the snapshot that recorded the entry', async () => {
    vi.mocked(mocks.indexes.list_by_owner).mockResolvedValue([
      make_index('file-fresh', [TARGET]),
      make_index('file-carried', [OLDER]),
    ]);

    const result = await verify();

    // The carried file's row sits under OLDER. Comparing against the verified
    // snapshot instead would flag it as a missing index version.
    expect(result.index_issues).toHaveLength(0);
  });

  it('flags a carried entry whose index row is filed under the verified snapshot', async () => {
    // The mirror image of the rule above, so the assertion cannot pass by
    // accepting any snapshot id at all.
    vi.mocked(mocks.indexes.list_by_owner).mockResolvedValue([
      make_index('file-fresh', [TARGET]),
      make_index('file-carried', [TARGET]),
    ]);

    const result = await verify();

    expect(result.index_issues).toHaveLength(1);
    expect(result.index_issues[0]).toContain('file-carried');
    expect(result.index_issues[0]).toContain(OLDER);
  });

  it('reports interrupted and reads nothing when aborted before the first entry', async () => {
    const result = await service.verify_onedrive_snapshot(TENANT_ID, OWNER_ID, TARGET, {
      should_interrupt: () => true,
    });

    expect(result).toMatchObject({ interrupted: true, total_checked: 0, passed: 0 });
    expect(mocks.read_keys).toHaveLength(0);
    // Aborted before any work: the context is never even created.
    expect(mocks.tenant_factory.create_readonly).not.toHaveBeenCalled();
  });

  it('starts no further object read after an interrupt mid-chain', async () => {
    vi.mocked(mocks.indexes.list_by_owner).mockResolvedValue([
      make_index('file-fresh', [TARGET]),
      make_index('file-carried', [OLDER]),
    ]);
    let interrupted = false;
    vi.mocked(mocks.ctx.storage.get_stream as ReturnType<typeof vi.fn>).mockImplementation(
      async (key: string) => {
        mocks.read_keys.push(key);
        interrupted = true;
        return stub_encrypted_object_store().stream(Buffer.alloc(64));
      },
    );

    const result = await service.verify_onedrive_snapshot(TENANT_ID, OWNER_ID, TARGET, {
      should_interrupt: () => interrupted,
    });

    expect(mocks.read_keys).toHaveLength(1);
    expect(result.interrupted).toBe(true);
    expect(result.total_checked).toBe(1);
  });

  it('accepts an owner id in any case, normalising before the lookup', async () => {
    await service.verify_onedrive_snapshot(TENANT_ID, OWNER_ID.toUpperCase(), TARGET);

    expect(mocks.manifests.find_by_snapshot).toHaveBeenCalledWith(
      expect.anything(),
      OWNER_ID,
      TARGET,
    );
  });
});
