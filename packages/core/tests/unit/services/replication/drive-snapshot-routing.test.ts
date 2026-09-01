import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplicationService } from '@/services/replication/replication.service';
import type {
  DekValidationFn,
  ManifestRepository,
  ObjectStorage,
  OneDriveReplicationUseCase,
  ReplicationResult,
  SharePointReplicationUseCase,
  StorageTarget,
  StorageTargetFactory,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { ReplicationStatus, ReplicationVerificationStatus } from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import type { AtlasConfig } from '@/utils/config';

vi.mock('@/services/replication/dek-rehydration-validator', () => ({
  ensure_source_dek_on_primary: vi.fn().mockResolvedValue(undefined),
}));

const OD_SNAPSHOT = 'od-snap-1735689600000-a1b2c3';
const SP_SNAPSHOT = 'sp-snap-1735689600000-d4e5f6';

function make_result(snapshot_id: string): ReplicationResult {
  return {
    snapshot_id,
    target_id: 'offsite',
    status: ReplicationStatus.COMPLETED,
    objects_total: 3,
    objects_copied: 3,
    objects_skipped: 0,
    objects_failed: 0,
    bytes_copied: 300,
    elapsed_ms: 1,
    errors: [],
    verification_status: ReplicationVerificationStatus.PASSED,
  };
}

function make_context(storage: ObjectStorage): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage,
    encrypt: vi.fn((d: Buffer) => d),
    decrypt: vi.fn((d: Buffer) => d),
    create_cipher: stub_tenant_create_cipher,
    create_decipher: vi.fn(),
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

function make_storage(keys: string[]): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn(async (prefix: string) => keys.filter((key) => key.startsWith(prefix))),
    list_versions: vi.fn(),
    begin_multipart_upload: vi.fn(),
    copy: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    probe_immutability: vi.fn(),
  } as unknown as ObjectStorage;
}

/** Manifest keys as the drive backup paths write them, one per workload. */
const STORED_KEYS = [
  `onedrive/manifests/owner-object-id/${OD_SNAPSHOT}.json`,
  `sharepoint/manifests/contoso.sharepoint.com,site-guid,web-guid/${SP_SNAPSHOT}.json`,
  'manifests/mailbox-1/snap-1735689600000-999999.json',
];

describe('ReplicationService drive snapshot routing (issue #91)', () => {
  let storage: ObjectStorage;
  let manifests: ManifestRepository;
  let onedrive: OneDriveReplicationUseCase;
  let sharepoint: SharePointReplicationUseCase;
  let target: StorageTarget;
  let service: ReplicationService;

  beforeEach(() => {
    storage = make_storage(STORED_KEYS);
    const ctx = make_context(storage);
    const tenant_factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(ctx),
    } as unknown as TenantContextFactory;

    manifests = {
      save: vi.fn(),
      find_by_snapshot: vi.fn().mockResolvedValue(undefined),
      find_latest_by_owner: vi.fn(),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    };

    const config: AtlasConfig = {
      tenant_id: 'tenant-1',
      client_id: 'c',
      client_secret: 's',
      s3_endpoint: 'http://primary:9000',
      s3_access_key: 'k',
      s3_secret_key: 's',
      s3_region: 'us-east-1',
      encryption_passphrase: 'pass',
    };

    target = {
      target_id: 'offsite',
      endpoint: 'http://offsite:9000',
      create_context: vi.fn().mockResolvedValue(make_context(storage)),
    };

    onedrive = {
      replicate_owner: vi.fn().mockResolvedValue([make_result(OD_SNAPSHOT)]),
      replicate_all_owner_snapshots: vi.fn(),
      rehydrate_owner_snapshot: vi.fn().mockResolvedValue(make_result(OD_SNAPSHOT)),
      rehydrate_owner: vi.fn(),
      rehydrate_all_owners: vi.fn(),
    };
    sharepoint = {
      replicate_site: vi.fn().mockResolvedValue([make_result(SP_SNAPSHOT)]),
      replicate_all_site_snapshots: vi.fn(),
      rehydrate_site_snapshot: vi.fn().mockResolvedValue(make_result(SP_SNAPSHOT)),
      rehydrate_site: vi.fn(),
      rehydrate_all_sites: vi.fn(),
    };

    service = new ReplicationService(
      tenant_factory,
      manifests,
      config,
      vi.fn().mockResolvedValue(undefined) as unknown as DekValidationFn,
      vi.fn().mockReturnValue(target) as unknown as StorageTargetFactory,
      onedrive,
      sharepoint,
    );
  });

  it('replicates a OneDrive snapshot through the OneDrive service, resolving the owner from storage', async () => {
    const results = await service.replicate_snapshot('tenant-1', OD_SNAPSHOT, [target]);

    expect(results).toEqual([make_result(OD_SNAPSHOT)]);
    expect(onedrive.replicate_owner).toHaveBeenCalledWith(
      'tenant-1',
      'owner-object-id',
      OD_SNAPSHOT,
      [target],
    );
    // The Outlook path must not be consulted: it would report the snapshot as nonexistent.
    expect(manifests.find_by_snapshot).not.toHaveBeenCalled();
  });

  it('replicates a SharePoint snapshot through the SharePoint service, keeping the composite site id intact', async () => {
    const results = await service.replicate_snapshot('tenant-1', SP_SNAPSHOT, [target]);

    expect(results).toEqual([make_result(SP_SNAPSHOT)]);
    expect(sharepoint.replicate_site).toHaveBeenCalledWith(
      'tenant-1',
      'contoso.sharepoint.com,site-guid,web-guid',
      SP_SNAPSHOT,
      [target],
    );
  });

  it('rehydrates drive snapshots through their own workload service', async () => {
    const od = await service.rehydrate_snapshot('tenant-1', OD_SNAPSHOT, target);
    const sp = await service.rehydrate_snapshot('tenant-1', SP_SNAPSHOT, target);

    expect(od).toEqual(make_result(OD_SNAPSHOT));
    expect(sp).toEqual(make_result(SP_SNAPSHOT));
    expect(onedrive.rehydrate_owner_snapshot).toHaveBeenCalledWith(
      'tenant-1',
      'owner-object-id',
      OD_SNAPSHOT,
      target,
    );
    expect(sharepoint.rehydrate_site_snapshot).toHaveBeenCalledWith(
      'tenant-1',
      'contoso.sharepoint.com,site-guid,web-guid',
      SP_SNAPSHOT,
      target,
    );
  });

  it('leaves Outlook snapshot ids on the Outlook path', async () => {
    await expect(
      service.replicate_snapshot('tenant-1', 'snap-1735689600000-999999', [target]),
    ).rejects.toThrow('No manifest found');

    expect(manifests.find_by_snapshot).toHaveBeenCalled();
    expect(onedrive.replicate_owner).not.toHaveBeenCalled();
    expect(sharepoint.replicate_site).not.toHaveBeenCalled();
  });

  it('reports a drive snapshot that exists nowhere as missing rather than routing it blindly', async () => {
    const empty = make_storage([]);
    const ctx = make_context(empty);
    const service_without_data = new ReplicationService(
      { create: vi.fn().mockResolvedValue(ctx) } as unknown as TenantContextFactory,
      manifests,
      {
        tenant_id: 'tenant-1',
        client_id: 'c',
        client_secret: 's',
        s3_endpoint: 'http://primary:9000',
        s3_access_key: 'k',
        s3_secret_key: 's',
        s3_region: 'us-east-1',
        encryption_passphrase: 'pass',
      },
      vi.fn().mockResolvedValue(undefined) as unknown as DekValidationFn,
      vi.fn().mockReturnValue(target) as unknown as StorageTargetFactory,
      onedrive,
      sharepoint,
    );

    await expect(
      service_without_data.replicate_snapshot('tenant-1', OD_SNAPSHOT, [target]),
    ).rejects.toThrow('No manifest found');
    expect(onedrive.replicate_owner).not.toHaveBeenCalled();
  });
});
