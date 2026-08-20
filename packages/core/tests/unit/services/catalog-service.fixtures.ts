import { vi } from 'vitest';
import { Container } from 'inversify';
import { CatalogService } from '@/services/catalog/catalog.service';
import {
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  type ManifestRepository,
  type TenantContext,
  type TenantContextFactory,
  type ObjectStorage,
  type Manifest,
} from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';

/** Builds a manifest with sensible defaults, overridable per test. */
export function make_manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 't',
    owner_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date('2026-03-01T10:00:00Z'),
    total_objects: 50,
    total_size_bytes: 5000,
    delta_links: {},
    entries: [],
    ...overrides,
  };
}

/** Fully stubbed object storage port. */
export function make_mock_storage(): ObjectStorage {
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

/** Tenant context whose "encryption" just prefixes/strips a single marker byte. */
export function make_mock_context(): TenantContext {
  return {
    tenant_id: 'test-tenant',
    storage: make_mock_storage(),
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('E'), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(1)),
    create_cipher: stub_tenant_create_cipher,
    destroy: vi.fn(),
  };
}

export interface CatalogTestHarness {
  readonly service: CatalogService;
  readonly mock_manifests: ManifestRepository;
  readonly mock_context: TenantContext;
}

/** Wires a CatalogService against mocked manifest repository and tenant context ports. */
export function build_catalog_harness(): CatalogTestHarness {
  const mock_context = make_mock_context();

  const mock_manifests: ManifestRepository = {
    save: vi.fn(),
    find_by_snapshot: vi.fn().mockResolvedValue(undefined),
    find_latest_by_owner: vi.fn().mockResolvedValue(undefined),
    list_all_manifests: vi.fn().mockResolvedValue([]),
  };

  const mock_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(mock_context),
    create_readonly: vi.fn().mockResolvedValue(mock_context),
  };

  const container = new Container();
  container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
  container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
  container.bind(CatalogService).toSelf();

  return { service: container.get(CatalogService), mock_manifests, mock_context };
}

/** Stubs the next `storage.get` call to return the given ciphertext. */
export function stub_storage_get(ctx: TenantContext, ciphertext: Buffer): void {
  vi.mocked(ctx.storage.get).mockResolvedValue(ciphertext);
}
