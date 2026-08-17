import { vi } from 'vitest';
import { ReplicationStatus, ReplicationVerificationStatus } from '@wisecom/atlas-types';
import type {
  DekValidationFn,
  Manifest,
  ManifestEntry,
  ManifestRepository,
  ObjectStorage,
  OneDriveReplicationUseCase,
  ReplicationResult,
  SharePointReplicationUseCase,
  StorageTarget,
  TenantContext,
} from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import type { AtlasConfig } from '@/utils/config';

export const TEST_CONFIG: AtlasConfig = {
  tenant_id: 'tenant-1',
  client_id: 'c',
  client_secret: 's',
  s3_endpoint: 'http://primary:9000',
  s3_access_key: 'k',
  s3_secret_key: 's',
  s3_region: 'us-east-1',
  encryption_passphrase: 'pass',
};

export function make_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn().mockResolvedValue(Buffer.from('encrypted-blob')),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn(),
    begin_multipart_upload: vi.fn().mockResolvedValue({
      upload_part: vi.fn(),
      complete: vi.fn(),
      abort: vi.fn(),
    }),
    copy: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    probe_immutability: vi.fn(),
  };
}

export function make_ctx(storage: ObjectStorage): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage,
    encrypt: vi.fn((d: Buffer) => d),
    decrypt: vi.fn((d: Buffer) => d),
    create_cipher: stub_tenant_create_cipher,
    destroy: vi.fn(),
  };
}

export function make_entry(key: string): ManifestEntry {
  return {
    object_id: `obj-${key}`,
    storage_key: `data/mbx/${key}`,
    checksum: 'abc',
    size_bytes: 100,
  };
}

export function make_manifest(
  snapshot_id: string,
  owner_id = 'mbx-1',
  entries: ManifestEntry[] = [],
): Manifest {
  return {
    id: `manifest-${snapshot_id}`,
    tenant_id: 'tenant-1',
    owner_id,
    snapshot_id,
    created_at: new Date('2026-01-01'),
    total_objects: entries.length,
    total_size_bytes: entries.reduce((s, e) => s + e.size_bytes, 0),
    delta_links: {},
    entries,
  };
}

/** Builds a workload-level result as returned by the OneDrive/SharePoint tenant scopes. */
export function make_workload_result(
  snapshot_id: string,
  objects_copied: number,
  bytes_copied = 100,
): ReplicationResult {
  return {
    snapshot_id,
    target_id: 'offsite',
    status: ReplicationStatus.COMPLETED,
    objects_total: objects_copied,
    objects_copied,
    objects_skipped: 0,
    objects_failed: 0,
    bytes_copied,
    elapsed_ms: 5,
    errors: [],
    verification_status: ReplicationVerificationStatus.SKIPPED,
  };
}

export function make_manifest_repository(): ManifestRepository {
  return {
    save: vi.fn(),
    find_by_snapshot: vi.fn(),
    find_latest_by_owner: vi.fn(),
    list_all_manifests: vi.fn().mockResolvedValue([]),
  };
}

export function make_onedrive_replication_mock(): OneDriveReplicationUseCase {
  return {
    replicate_owner: vi.fn(),
    replicate_all_owner_snapshots: vi.fn(),
    replicate_all_owners: vi.fn().mockResolvedValue([]),
    rehydrate_owner_snapshot: vi.fn(),
    rehydrate_owner: vi.fn(),
    rehydrate_all_owners: vi.fn().mockResolvedValue(make_workload_result('0-owners', 0, 0)),
  };
}

export function make_sharepoint_replication_mock(): SharePointReplicationUseCase {
  return {
    replicate_site: vi.fn(),
    replicate_all_site_snapshots: vi.fn(),
    replicate_all_sites: vi.fn().mockResolvedValue([]),
    rehydrate_site_snapshot: vi.fn(),
    rehydrate_site: vi.fn(),
    rehydrate_all_sites: vi.fn().mockResolvedValue(make_workload_result('0-sites', 0, 0)),
  };
}

export function make_storage_target(
  target_id: string,
  ctx: TenantContext,
  endpoint = 'http://offsite:9000',
): StorageTarget {
  return { target_id, endpoint, create_context: vi.fn().mockResolvedValue(ctx) };
}

export function make_dek_validator(): DekValidationFn {
  return vi.fn().mockResolvedValue(undefined) as unknown as DekValidationFn;
}
