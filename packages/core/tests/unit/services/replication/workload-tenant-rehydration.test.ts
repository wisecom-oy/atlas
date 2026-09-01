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
import { stub_tenant_create_decipher } from '@wisecom/atlas-types/testing/stub-tenant-create-decipher';
import type { AtlasConfig } from '@/utils/config';

vi.mock('@/services/replication/dek-rehydration-validator', () => ({
  ensure_source_dek_on_primary: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/replication/rehydration-manifests-runner', () => ({
  rehydrate_manifests: vi.fn().mockResolvedValue({
    objects_copied: 4,
    objects_skipped: 0,
    objects_failed: 0,
    bytes_copied: 400,
    errors: [],
    snapshot_id: 'snap',
    // Literal rather than the enum: vi.mock factories are hoisted above the imports.
    status: 'COMPLETED',
    verification_status: 'SKIPPED',
  }),
}));

import { rehydrate_manifests } from '@/services/replication/rehydration-manifests-runner';

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
    get_with_etag: vi.fn(),
    get_stream: vi.fn(),
    apply_default_retention: vi.fn(),
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
    create_decipher: stub_tenant_create_decipher,
    destroy: vi.fn(),
  };
}

function onedrive_manifest(owner_id: string, snapshot_id: string): OneDriveSnapshotManifest {
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

function sharepoint_manifest(site_id: string, snapshot_id: string): SharePointSnapshotManifest {
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
    tenant_factory = {
      create: vi.fn().mockResolvedValue(primary_ctx),
      create_readonly: vi.fn().mockResolvedValue(primary_ctx),
      create_storage_only: vi.fn().mockResolvedValue(primary_ctx),
    };
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
          onedrive_manifest('owner-a', 'od-1'),
          onedrive_manifest('owner-a', 'od-2'),
          onedrive_manifest('owner-b', 'od-3'),
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

    expect(rehydrate_manifests).toHaveBeenCalledTimes(2);
    expect(result.snapshot_id).toBe('2-owners');
    expect(result.objects_copied).toBe(8);
    expect(result.bytes_copied).toBe(800);
    expect(result.status).toBe(ReplicationStatus.COMPLETED);
  });

  it('rehydrate_all_owners collects ancillary keys per owner, never one owner for all', async () => {
    // Keyed on the exact prefix: version rows live in per-run objects since
    // issue #161, so a collector scoped to `files/` would replicate nothing.
    const objects: Record<string, string[]> = {
      'onedrive/index/owner-a/': [
        'onedrive/index/owner-a/files/1',
        'onedrive/index/owner-a/runs/od-1.json',
      ],
      'onedrive/index/owner-b/': ['onedrive/index/owner-b/runs/od-2.json'],
    };
    vi.mocked(source_storage.list).mockImplementation(async (prefix: string) =>
      prefix in objects ? (objects[prefix] as string[]) : [],
    );
    const manifests: OneDriveManifestRepository = {
      save: vi.fn(),
      find_by_snapshot: vi.fn(),
      find_latest_by_owner: vi.fn(),
      list_snapshots_by_owner: vi.fn(),
      list_all_manifests: vi
        .fn()
        .mockResolvedValue([
          onedrive_manifest('owner-a', 'od-1'),
          onedrive_manifest('owner-b', 'od-2'),
        ]),
    };
    const service = new OneDriveReplicationService(
      tenant_factory,
      manifests,
      CONFIG,
      validate_dek,
      target_factory,
    );

    await service.rehydrate_all_owners('tenant-1', source);

    const calls = vi.mocked(rehydrate_manifests).mock.calls;
    expect(calls).toHaveLength(2);
    // Check that each call passed the correct ancillary keys
    const ancillary_by_owner = new Map(
      calls.map((c) => {
        const manifests = c[2] as OneDriveSnapshotManifest[];
        const owner = manifests[0]?.owner_id;
        const plan = c[7] as {
          replicate: (s: unknown, p: unknown, m: unknown, k: string) => unknown;
        };
        return [owner, { manifests: manifests.map((m) => m.snapshot_id), plan_exists: !!plan }];
      }),
    );
    expect(ancillary_by_owner.get('owner-a')).toBeTruthy();
    expect(ancillary_by_owner.get('owner-b')).toBeTruthy();
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

    expect(rehydrate_manifests).not.toHaveBeenCalled();
    expect(result.objects_copied).toBe(0);
    expect(result.snapshot_id).toBe('0-owners');
  });

  it('rehydrate_all_sites recovers every site found on the replica', async () => {
    vi.mocked(rehydrate_manifests).mockResolvedValue({
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
        .mockResolvedValue([
          sharepoint_manifest('site-a', 'sp-1'),
          sharepoint_manifest('site-b', 'sp-2'),
        ]),
    };
    const service = new SharePointReplicationService(
      tenant_factory,
      manifests,
      CONFIG,
      validate_dek,
      target_factory,
    );

    const result = await service.rehydrate_all_sites('tenant-1', source);

    expect(rehydrate_manifests).toHaveBeenCalledTimes(2);
    expect(result.snapshot_id).toBe('2-sites');
    expect(result.objects_copied).toBe(60);
    expect(result.bytes_copied).toBe(6000);
  });
});
