import { outlook_chain_reads } from '@wisecom/atlas-types/testing/stub-outlook-manifest-chain';
import { vi } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { DeletionService } from '@/services/deletion/deletion.service';
import {
  MANIFEST_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  type ManifestRepository,
  type TenantContext,
  type TenantContextFactory,
  type ObjectStorage,
  type Manifest,
} from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { stub_tenant_create_decipher } from '@wisecom/atlas-types/testing/stub-tenant-create-decipher';
import { latest_readable, readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

/** An Outlook manifest of `user@test.com` with no entries. */
export function make_manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 't',
    owner_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date('2026-03-01T10:00:00Z'),
    total_objects: 10,
    total_size_bytes: 1000,
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
    list_stale: vi.fn(async () => []),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn().mockResolvedValue([]),
    begin_multipart_upload: vi.fn().mockResolvedValue({
      upload_part: vi.fn(),
      complete: vi.fn(),
      abort: vi.fn(),
    }),
    copy: vi.fn(),
    get_with_etag: vi.fn(),
    get_stream: vi.fn(),
    validate_object_lock_policy: vi.fn(),
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
    encrypt: vi.fn((data: Buffer) => data),
    decrypt: vi.fn((data: Buffer) => data),
    create_cipher: stub_tenant_create_cipher,
    create_content_hmac: stub_tenant_create_content_hmac,
    create_decipher: stub_tenant_create_decipher,
    destroy: vi.fn(),
  };
}

/** A `DeletionService` over mocked storage, manifests and leases. */
export interface DeletionServiceRig {
  readonly service: DeletionService;
  readonly mock_manifests: ManifestRepository;
  readonly mock_context: TenantContext;
  readonly mock_factory: TenantContextFactory;
}

/** Builds the service from the container, as the CLI and SDK resolve it. */
export function deletion_service_rig(): DeletionServiceRig {
  const mock_context = make_mock_context();
  const mock_manifests: ManifestRepository = {
    save: vi.fn(),
    forget_snapshot_summary: vi.fn(),
    find_by_snapshot: vi.fn().mockResolvedValue(undefined),
    list_by_owner: vi.fn().mockResolvedValue([]),
    find_latest_readable: vi.fn().mockResolvedValue(latest_readable(undefined)),
    list_all_manifests: vi.fn().mockResolvedValue([]),
    list_owner_ids: vi.fn().mockResolvedValue([]),
    list_readable_by_owner: vi.fn().mockResolvedValue(readable_manifests()),
    list_all_readable: vi.fn().mockResolvedValue(readable_manifests()),
    read_manifest_at: vi.fn(outlook_chain_reads(() => mock_manifests).read_manifest_at),
    list_snapshot_summaries: vi.fn(
      outlook_chain_reads(() => mock_manifests).list_snapshot_summaries,
    ),
  };
  const mock_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(mock_context),
    create_readonly: vi.fn().mockResolvedValue(mock_context),
    create_storage_only: vi.fn().mockResolvedValue({
      tenant_id: mock_context.tenant_id,
      storage: mock_context.storage,
    }),
  };

  const container = new Container();
  container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
  container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
  container.bind(OWNER_LEASE_TOKEN).toConstantValue(stub_owner_leases().leases);
  container.bind(DeletionService).toSelf();

  return { service: container.get(DeletionService), mock_manifests, mock_context, mock_factory };
}
