import { outlook_chain_reads } from '@wisecom/atlas-types/testing/stub-outlook-manifest-chain';
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
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { stub_tenant_create_decipher } from '@wisecom/atlas-types/testing/stub-tenant-create-decipher';
import { latest_readable, readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';
import type { OutlookSnapshotSummary, ReadableSnapshotSummaries } from '@wisecom/atlas-types';
import { build_outlook_aggregates } from '@/services/catalog/outlook-snapshot-aggregates';

/**
 * The summary listing the index would answer for these manifests: each row carries the aggregates
 * the summary path reads, built from its manifest exactly as the writer builds them (#726).
 */
export function summary_listing(
  manifests: readonly Manifest[],
  unreadable_keys: string[] = [],
): ReadableSnapshotSummaries<OutlookSnapshotSummary> {
  const summaries: OutlookSnapshotSummary[] = manifests.map((manifest) => ({
    snapshot_id: manifest.snapshot_id,
    created_at: manifest.created_at,
    manifest_key: `manifests/${manifest.owner_id}/${manifest.snapshot_id}.json`,
    entry_count: manifest.entries.length,
    total_size_bytes: manifest.total_size_bytes,
    owner_id: manifest.owner_id,
    owner_email: manifest.owner_email,
    owner_display_name: manifest.owner_display_name,
    mailbox_purpose: manifest.mailbox_purpose,
    total_objects: manifest.total_objects,
    removed_count: manifest.removed_object_ids?.length ?? 0,
    aggregates: build_outlook_aggregates(manifest),
  }));
  return { summaries, unreadable_keys };
}

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

/** Tenant context whose "encryption" just prefixes/strips a single marker byte. */
export function make_mock_context(): TenantContext {
  return {
    tenant_id: 'test-tenant',
    storage: make_mock_storage(),
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('E'), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(1)),
    create_cipher: stub_tenant_create_cipher,
    create_content_hmac: stub_tenant_create_content_hmac,
    create_decipher: stub_tenant_create_decipher,
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
    forget_snapshot_summary: vi.fn(),
    find_by_snapshot: vi.fn().mockResolvedValue(undefined),
    list_by_owner: vi.fn().mockResolvedValue([]),
    find_latest_readable: vi.fn().mockResolvedValue(latest_readable(undefined)),
    list_all_manifests: vi.fn().mockResolvedValue([]),
    list_owner_ids: vi.fn().mockResolvedValue([]),
    list_readable_by_owner: vi.fn().mockResolvedValue(readable_manifests()),
    list_all_readable: vi.fn().mockResolvedValue(readable_manifests()),
    list_all_snapshot_summaries: vi.fn().mockResolvedValue(summary_listing([])),
    read_manifest_at: vi.fn(outlook_chain_reads(() => mock_manifests).read_manifest_at),
    list_snapshot_summaries: vi.fn(
      outlook_chain_reads(() => mock_manifests).list_snapshot_summaries,
    ),
  };

  const mock_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(mock_context),
    create_readonly: vi.fn().mockResolvedValue(mock_context),
    create_storage_only: vi.fn().mockResolvedValue(mock_context),
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
