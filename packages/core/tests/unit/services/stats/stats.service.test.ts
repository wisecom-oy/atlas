import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { StatsService } from '@/services/stats/stats.service';
import {
  MANIFEST_REPOSITORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  type ManifestRepository,
  type OneDriveManifestRepository,
  type SharePointManifestRepository,
  type OneDriveSnapshotManifest,
  type SharePointSnapshotManifest,
  type TenantContext,
  type TenantContextFactory,
  type ObjectStorage,
  type Manifest,
} from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';

function make_manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 't',
    owner_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date('2026-03-01T10:00:00Z'),
    total_objects: 1,
    total_size_bytes: 100,
    delta_links: {},
    entries: [],
    ...overrides,
  };
}

function make_mock_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn().mockResolvedValue([]),
    begin_multipart_upload: vi.fn().mockResolvedValue({
      upload_part: vi.fn(),
      complete: vi.fn(),
      abort: vi.fn(),
    }),
    copy: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    probe_immutability: vi.fn().mockResolvedValue({
      bucket: 'test-bucket',
      reachable: true,
      versioning_enabled: true,
      object_lock_enabled: true,
      mode_supported: true,
    }),
  };
}

function make_mock_context(): TenantContext {
  return {
    tenant_id: 'test-tenant',
    storage: make_mock_storage(),
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('E'), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(1)),
    create_cipher: stub_tenant_create_cipher,
    destroy: vi.fn(),
  };
}

describe('StatsService', () => {
  let mock_manifests: ManifestRepository;
  let mock_od_manifests: OneDriveManifestRepository;
  let mock_sp_manifests: SharePointManifestRepository;
  let service: StatsService;

  beforeEach(() => {
    const mock_context = make_mock_context();

    mock_manifests = {
      save: vi.fn(),
      find_by_snapshot: vi.fn().mockResolvedValue(undefined),
      find_latest_by_owner: vi.fn().mockResolvedValue(undefined),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    };

    mock_od_manifests = {
      list_snapshots_by_owner: vi.fn().mockResolvedValue([]),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    } as unknown as OneDriveManifestRepository;

    mock_sp_manifests = {
      list_snapshots_by_site: vi.fn().mockResolvedValue([]),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    } as unknown as SharePointManifestRepository;

    const mock_factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(mock_context),
      create_readonly: vi.fn().mockResolvedValue(mock_context),
    };

    const container = new Container();
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_od_manifests);
    container.bind(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_sp_manifests);
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(StatsService).toSelf();

    service = container.get(StatsService);
  });

  // ---------------------------------------------------------------------------
  // get_bucket_stats
  // ---------------------------------------------------------------------------

  describe('get_bucket_stats', () => {
    it('returns zeroed stats when no manifests exist', async () => {
      const result = await service.get_bucket_stats('t');

      expect(result.tenant_id).toBe('t');
      expect(result.mailbox_count).toBe(0);
      expect(result.snapshot_count).toBe(0);
      expect(result.total_messages).toBe(0);
      expect(result.total_size_bytes).toBe(0);
      expect(result.aggregation_us).toBeGreaterThanOrEqual(0);
    });

    it('aggregates across multiple mailboxes', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({
          owner_id: 'alice@test.com',
          entries: [{ object_id: 'o1', storage_key: 'k1', checksum: 'c1', size_bytes: 200 }],
        }),
        make_manifest({
          owner_id: 'bob@test.com',
          entries: [{ object_id: 'o2', storage_key: 'k2', checksum: 'c2', size_bytes: 300 }],
        }),
      ]);

      const result = await service.get_bucket_stats('t');

      expect(result.mailbox_count).toBe(2);
      expect(result.snapshot_count).toBe(2);
      expect(result.total_messages).toBe(2);
      expect(result.total_size_bytes).toBe(500);
      expect(result.aggregation_us).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // get_mailbox_stats
  // ---------------------------------------------------------------------------

  describe('get_mailbox_stats', () => {
    it('returns zeroed stats when mailbox has no manifests', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({ owner_id: 'other@test.com' }),
      ]);

      const result = await service.get_mailbox_stats('t', 'missing@test.com');

      expect(result.owner_id).toBe('missing@test.com');
      expect(result.snapshot_count).toBe(0);
      expect(result.total_messages).toBe(0);
      expect(result.aggregation_us).toBeGreaterThanOrEqual(0);
    });

    it('filters manifests to the requested mailbox', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({
          owner_id: 'alice@test.com',
          entries: [
            {
              object_id: 'o1',
              storage_key: 'k1',
              checksum: 'c1',
              size_bytes: 200,
              folder_id: 'inbox',
            },
          ],
        }),
        make_manifest({
          owner_id: 'bob@test.com',
          entries: [{ object_id: 'o2', storage_key: 'k2', checksum: 'c2', size_bytes: 300 }],
        }),
        make_manifest({
          owner_id: 'alice@test.com',
          entries: [
            {
              object_id: 'o3',
              storage_key: 'k3',
              checksum: 'c3',
              size_bytes: 150,
              folder_id: 'sent',
            },
          ],
        }),
      ]);

      const result = await service.get_mailbox_stats('t', 'alice@test.com');

      expect(result.owner_id).toBe('alice@test.com');
      expect(result.snapshot_count).toBe(2);
      expect(result.total_messages).toBe(2);
      expect(result.total_size_bytes).toBe(350);
      expect(result.folders).toHaveLength(2);
    });

    it('normalizes owner_id to lowercase', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({
          owner_id: 'alice@test.com',
          entries: [{ object_id: 'o1', storage_key: 'k1', checksum: 'c1', size_bytes: 100 }],
        }),
      ]);

      const result = await service.get_mailbox_stats('t', 'Alice@Test.com');

      expect(result.owner_id).toBe('alice@test.com');
      expect(result.snapshot_count).toBe(1);
      expect(result.total_messages).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // get_onedrive_stats / get_sharepoint_stats
  // ---------------------------------------------------------------------------

  describe('get_onedrive_stats', () => {
    const od_manifest = (overrides: Partial<OneDriveSnapshotManifest>): OneDriveSnapshotManifest =>
      ({
        owner_id: 'owner-1',
        snapshot_id: 's1',
        created_at: new Date('2026-03-05T00:00:00Z'),
        total_files: 3,
        total_size_bytes: 100,
        entries: [],
        ...overrides,
      }) as OneDriveSnapshotManifest;

    it('aggregates all owners when no owner is given', async () => {
      vi.mocked(mock_od_manifests.list_all_manifests).mockResolvedValue([
        od_manifest({ owner_id: 'a', owner_email: 'a@test.com' }),
        od_manifest({ owner_id: 'b', snapshot_id: 's2', total_size_bytes: 400 }),
      ]);

      const result = await service.get_onedrive_stats('t');

      expect(result.service).toBe('onedrive');
      expect(result.owner_count).toBe(2);
      expect(result.snapshot_count).toBe(2);
      expect(result.file_count).toBe(6);
      expect(result.total_size_bytes).toBe(500);
      expect(result.owners[0]?.owner_id).toBe('b');
      expect(result.owners[1]?.owner_label).toBe('a@test.com');
      expect(result.monthly_breakdown).toEqual([
        { month: '2026-03', snapshot_count: 2, file_count: 6, total_size_bytes: 500 },
      ]);
      expect(mock_od_manifests.list_snapshots_by_owner).not.toHaveBeenCalled();
    });

    it('scopes to a single owner when given', async () => {
      vi.mocked(mock_od_manifests.list_snapshots_by_owner).mockResolvedValue([
        od_manifest({ owner_id: 'a' }),
      ]);

      const result = await service.get_onedrive_stats('t', 'a');

      expect(result.owner_count).toBe(1);
      expect(result.snapshot_count).toBe(1);
      expect(mock_od_manifests.list_all_manifests).not.toHaveBeenCalled();
    });
  });

  describe('get_sharepoint_stats', () => {
    const sp_manifest = (
      overrides: Partial<SharePointSnapshotManifest>,
    ): SharePointSnapshotManifest =>
      ({
        site_id: 'site-1',
        snapshot_id: 's1',
        created_at: new Date('2026-04-10T00:00:00Z'),
        total_files: 5,
        total_size_bytes: 250,
        entries: [],
        ...overrides,
      }) as SharePointSnapshotManifest;

    it('aggregates all sites and labels them by display name', async () => {
      vi.mocked(mock_sp_manifests.list_all_manifests).mockResolvedValue([
        sp_manifest({ site_display_name: 'Intranet' }),
        sp_manifest({ snapshot_id: 's2' }),
      ]);

      const result = await service.get_sharepoint_stats('t');

      expect(result.service).toBe('sharepoint');
      expect(result.owner_count).toBe(1);
      expect(result.snapshot_count).toBe(2);
      expect(result.file_count).toBe(10);
      expect(result.total_size_bytes).toBe(500);
      expect(result.owners[0]?.owner_label).toBe('Intranet');
      expect(result.owners[0]?.latest_backup_at).toBe('2026-04-10T00:00:00.000Z');
    });

    it('scopes to a single site when given', async () => {
      vi.mocked(mock_sp_manifests.list_snapshots_by_site).mockResolvedValue([sp_manifest({})]);

      const result = await service.get_sharepoint_stats('t', 'site-1');

      expect(result.snapshot_count).toBe(1);
      expect(mock_sp_manifests.list_all_manifests).not.toHaveBeenCalled();
    });
  });
});
