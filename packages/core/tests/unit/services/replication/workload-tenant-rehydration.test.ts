import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OneDriveReplicationService } from '@/services/replication/onedrive-replication.service';
import { SharePointReplicationService } from '@/services/replication/sharepoint-replication.service';
import { ReplicationStatus } from '@wisecom/atlas-types';
import type {
  TenantContext,
  TenantContextFactory,
  ObjectStorage,
  StorageTarget,
  StorageTargetFactory,
  DekValidationFn,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  SharePointManifestRepository,
  SharePointSnapshotManifest,
} from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import type { AtlasConfig } from '@/utils/config';

import { replicate_onedrive_snapshot } from '@/services/replication/onedrive-snapshot-replicator';
import { rehydrate_sp_manifests } from '@/services/replication/rehydration-sp-manifests-runner';
vi.mock('@/services/replication/rehydration-dek-helper', () => ({
  ensure_source_dek_on_primary: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/replication/onedrive-snapshot-replicator', () => ({
  replicate_onedrive_snapshot: vi.fn().mockResolvedValue({
    objects_copied: 4,
    objects_skipped: 0,
    objects_failed: 0,
    bytes_copied: 400,
    errors: [],
  }),
}));

vi.mock('@/services/replication/rehydration-sp-manifests-runner', () => ({
  rehydrate_sp_manifests: vi.fn(),
}));

const CONFIG: AtlasConfig = {
  tenant_id: 'tenant-1',
  client_id: 'c',
  client_secret: 's',
  s3_endpoint: 'http://primary:9000',
  s3_access_key: 'k',
  s3_secret_key: 's',
  s3_region: 'us-east-1',
  encryption_passphrase: 'pass',
};

function make_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn().mockResolvedValue(Buffer.from('blob')),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn(),
    begin_multipart_upload: vi.fn(),
    copy: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    probe_immutability: vi.fn(),
  };
}

function make_ctx(storage: ObjectStorage): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage,
    encrypt: vi.fn((d: Buffer) => d),
    decrypt: vi.fn((d: Buffer) => d),
    create_cipher: stub_tenant_create_cipher,
    destroy: vi.fn(),
  };
}

function od_manifest(owner_id: string, snapshot_id: string): OneDriveSnapshotManifest {
  return {
    id: `m-${snapshot_id}`,
    tenant_id: 'tenant-1',
    owner_id,
    snapshot_id,
    created_at: new Date('2026-01-01'),
    total_files: 1,
    total_size_bytes: 100,
    entries: [{ file_id: 'f1', path: '/a.txt', storage_key: `onedrive/data/${owner_id}/aaa` }],
  } as unknown as OneDriveSnapshotManifest;
}

function sp_manifest(site_id: string, snapshot_id: string): SharePointSnapshotManifest {
  return {
    id: `m-${snapshot_id}`,
    tenant_id: 'tenant-1',
    site_id,
    snapshot_id,
    created_at: new Date('2026-01-01'),
    total_files: 1,
    total_size_bytes: 100,
    entries: [],
  } as unknown as SharePointSnapshotManifest;
}

describe('tenant-wide workload rehydration', () => {
  let source_storage: ObjectStorage;
  let primary_storage: ObjectStorage;
  let source_ctx: TenantContext;
  let primary_ctx: TenantContext;
  let tenant_factory: TenantContextFactory;
  let validate_dek: DekValidationFn;
  let target_factory: StorageTargetFactory;
  let source: StorageTarget;

  beforeEach(() => {
    vi.clearAllMocks();
    source_storage = make_storage();
    primary_storage = make_storage();
    source_ctx = make_ctx(source_storage);
    primary_ctx = make_ctx(primary_storage);
    tenant_factory = { create: vi.fn().mockResolvedValue(primary_ctx) };
    validate_dek = vi.fn().mockResolvedValue(undefined) as unknown as DekValidationFn;
    target_factory = vi.fn().mockReturnValue({
      target_id: 'primary',
      endpoint: 'http://primary:9000',
      create_context: vi.fn().mockResolvedValue(primary_ctx),
    }) as unknown as StorageTargetFactory;
    source = {
      target_id: 'replica',
      endpoint: 'http://replica:9000',
      create_context: vi.fn().mockResolvedValue(source_ctx),
    };
  });

  it('rehydrate_all_owners recovers every owner found on the replica', async () => {
    const manifests: OneDriveManifestRepository = {
      save: vi.fn(),
      find_by_snapshot: vi.fn(),
      find_latest_by_owner: vi.fn(),
      list_snapshots_by_owner: vi.fn(),
      list_all_manifests: vi
        .fn()
        .mockResolvedValue([
          od_manifest('owner-a', 'od-1'),
          od_manifest('owner-a', 'od-2'),
          od_manifest('owner-b', 'od-3'),
        ]),
    };
    const service = new OneDriveReplicationService(
      tenant_factory,
      manifests,
      CONFIG,
      validate_dek,
      target_factory,
    );

    const result = await service.rehydrate_all_owners('tenant-1', source);

    expect(replicate_onedrive_snapshot).toHaveBeenCalledTimes(3);
    expect(result.snapshot_id).toBe('2-owners');
    expect(result.objects_copied).toBe(12);
    expect(result.bytes_copied).toBe(1200);
    expect(result.status).toBe(ReplicationStatus.COMPLETED);
  });

  it('rehydrate_all_owners collects ancillary keys per owner, never one owner for all', async () => {
    vi.mocked(source_storage.list).mockImplementation(async (prefix: string) => {
      if (prefix.includes('owner-a')) return ['onedrive/index/owner-a/files/1'];
      if (prefix.includes('owner-b')) return ['onedrive/index/owner-b/files/2'];
      return [];
    });
    const manifests: OneDriveManifestRepository = {
      save: vi.fn(),
      find_by_snapshot: vi.fn(),
      find_latest_by_owner: vi.fn(),
      list_snapshots_by_owner: vi.fn(),
      list_all_manifests: vi
        .fn()
        .mockResolvedValue([od_manifest('owner-a', 'od-1'), od_manifest('owner-b', 'od-2')]),
    };
    const service = new OneDriveReplicationService(
      tenant_factory,
      manifests,
      CONFIG,
      validate_dek,
      target_factory,
    );

    await service.rehydrate_all_owners('tenant-1', source);

    const calls = vi.mocked(replicate_onedrive_snapshot).mock.calls;
    const ancillary_by_snapshot = new Map(
      calls.map((c) => [c[2].snapshot_id, c[4]?.ancillary_keys]),
    );
    expect(ancillary_by_snapshot.get('od-1')).toEqual(['onedrive/index/owner-a/files/1']);
    expect(ancillary_by_snapshot.get('od-2')).toEqual(['onedrive/index/owner-b/files/2']);
  });

  it('rehydrate_all_owners returns an empty result when the replica holds no OneDrive data', async () => {
    const manifests: OneDriveManifestRepository = {
      save: vi.fn(),
      find_by_snapshot: vi.fn(),
      find_latest_by_owner: vi.fn(),
      list_snapshots_by_owner: vi.fn(),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    };
    const service = new OneDriveReplicationService(
      tenant_factory,
      manifests,
      CONFIG,
      validate_dek,
      target_factory,
    );

    const result = await service.rehydrate_all_owners('tenant-1', source);

    expect(replicate_onedrive_snapshot).not.toHaveBeenCalled();
    expect(result.objects_copied).toBe(0);
    expect(result.snapshot_id).toBe('0-owners');
  });

  it('rehydrate_all_sites recovers every site found on the replica', async () => {
    vi.mocked(rehydrate_sp_manifests).mockResolvedValue({
      snapshot_id: 'sp',
      target_id: 'replica',
      status: ReplicationStatus.COMPLETED,
      objects_total: 30,
      objects_copied: 30,
      objects_skipped: 0,
      objects_failed: 0,
      bytes_copied: 3000,
      elapsed_ms: 4,
      errors: [],
      verification_status: 'SKIPPED',
    } as never);

    const manifests: SharePointManifestRepository = {
      save: vi.fn(),
      find_by_snapshot: vi.fn(),
      find_latest_by_site: vi.fn(),
      list_snapshots_by_site: vi.fn(),
      list_all_manifests: vi
        .fn()
        .mockResolvedValue([sp_manifest('site-a', 'sp-1'), sp_manifest('site-b', 'sp-2')]),
    };
    const service = new SharePointReplicationService(
      tenant_factory,
      manifests,
      CONFIG,
      validate_dek,
      target_factory,
    );

    const result = await service.rehydrate_all_sites('tenant-1', source);

    expect(rehydrate_sp_manifests).toHaveBeenCalledTimes(2);
    expect(result.snapshot_id).toBe('2-sites');
    expect(result.objects_copied).toBe(60);
    expect(result.bytes_copied).toBe(6000);
  });
});
