import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplicationService } from '@/services/replication/replication.service';
import { ReplicationStatus } from '@/domain/replication';
import type { TenantContext, TenantContextFactory } from '@/ports/tenant/context.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';
import type { Manifest, ManifestEntry } from '@/domain/manifest';
import type { StorageTarget, StorageTargetFactory } from '@/ports/replication/storage-target.port';
import type { DekValidationFn } from '@/ports/replication/dek-validation.port';
import type { AtlasConfig } from '@/utils/config';

vi.mock('@/services/replication/rehydration-dek-helper', () => ({
  ensure_source_dek_on_primary: vi.fn().mockResolvedValue(undefined),
}));

function make_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn().mockResolvedValue(Buffer.from('encrypted-blob')),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn(),
    probe_immutability: vi.fn(),
  };
}

function make_entry(key: string): ManifestEntry {
  return {
    object_id: `obj-${key}`,
    storage_key: `data/mbx/${key}`,
    checksum: 'abc',
    size_bytes: 100,
  };
}

function make_manifest(
  snapshot_id: string,
  mailbox_id = 'mbx-1',
  entries: ManifestEntry[] = [],
): Manifest {
  return {
    id: `manifest-${snapshot_id}`,
    tenant_id: 'tenant-1',
    mailbox_id,
    snapshot_id,
    created_at: new Date('2026-01-01'),
    total_objects: entries.length,
    total_size_bytes: entries.reduce((s, e) => s + e.size_bytes, 0),
    delta_links: {},
    entries,
  };
}

describe('ReplicationService', () => {
  let source_storage: ObjectStorage;
  let target_storage: ObjectStorage;
  let source_ctx: TenantContext;
  let target_ctx: TenantContext;
  let tenant_factory: TenantContextFactory;
  let manifests: ManifestRepository;
  let config: AtlasConfig;
  let target: StorageTarget;
  let validate_dek: DekValidationFn;
  let target_factory: StorageTargetFactory;
  let service: ReplicationService;

  beforeEach(() => {
    source_storage = make_storage();
    target_storage = make_storage();

    source_ctx = {
      tenant_id: 'tenant-1',
      storage: source_storage,
      encrypt: vi.fn((d: Buffer) => d),
      decrypt: vi.fn((d: Buffer) => d),
    };

    target_ctx = {
      tenant_id: 'tenant-1',
      storage: target_storage,
      encrypt: vi.fn((d: Buffer) => d),
      decrypt: vi.fn((d: Buffer) => d),
    };

    tenant_factory = { create: vi.fn().mockResolvedValue(source_ctx) };

    manifests = {
      save: vi.fn(),
      find_by_snapshot: vi.fn(),
      find_latest_by_mailbox: vi.fn(),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    };

    config = {
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
      create_context: vi.fn().mockResolvedValue(target_ctx),
    };

    validate_dek = vi.fn().mockResolvedValue(undefined) as unknown as DekValidationFn;
    target_factory = vi.fn().mockReturnValue(target) as unknown as StorageTargetFactory;
    service = new ReplicationService(
      tenant_factory,
      manifests,
      config,
      validate_dek,
      target_factory,
    );
  });

  it('replicates a single snapshot to a target', async () => {
    const entry = make_entry('hash-1');
    const manifest = make_manifest('snap-1', 'mbx-1', [entry]);
    vi.mocked(manifests.find_by_snapshot).mockResolvedValue(manifest);
    vi.mocked(source_storage.get).mockResolvedValue(Buffer.from('data'));
    vi.mocked(target_storage.get).mockResolvedValue(Buffer.from('data'));

    const results = await service.replicate_snapshot('tenant-1', 'snap-1', [target]);

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe(ReplicationStatus.COMPLETED);
    expect(results[0]!.objects_copied).toBe(1);
  });

  it('throws when snapshot manifest is not found', async () => {
    vi.mocked(manifests.find_by_snapshot).mockResolvedValue(undefined);

    await expect(service.replicate_snapshot('tenant-1', 'snap-missing', [target])).rejects.toThrow(
      'No manifest found',
    );
  });

  it('replicate_mailbox diffs and only replicates missing snapshots', async () => {
    const m1 = make_manifest('snap-1', 'mbx-1', [make_entry('a')]);
    const m2 = make_manifest('snap-2', 'mbx-1', [make_entry('b')]);

    vi.mocked(manifests.list_all_manifests).mockResolvedValue([m1, m2]);
    vi.mocked(target_storage.list).mockResolvedValue(['manifests/mbx-1/snap-1.json']);
    vi.mocked(source_storage.get).mockResolvedValue(Buffer.from('data'));
    vi.mocked(target_storage.get).mockResolvedValue(Buffer.from('data'));

    const results = await service.replicate_mailbox('tenant-1', 'mbx-1', [target]);

    expect(results).toHaveLength(1);
    expect(results[0]!.snapshot_id).toBe('snap-2');
  });

  it('rehydrate_snapshot skips when manifest exists on primary', async () => {
    const manifest = make_manifest('snap-1', 'mbx-1', [make_entry('a')]);
    vi.mocked(manifests.find_by_snapshot).mockResolvedValue(manifest);
    vi.mocked(source_storage.exists).mockResolvedValue(true);

    const source_target: StorageTarget = {
      target_id: 'offsite',
      endpoint: 'http://offsite:9000',
      create_context: vi.fn().mockResolvedValue(target_ctx),
    };

    vi.mocked(target_storage.exists).mockResolvedValue(false);

    const spy = vi.mocked(source_storage.exists);
    spy.mockImplementation(async (key: string) => {
      if (key === 'manifests/mbx-1/snap-1.json') return true;
      return false;
    });

    const result = await service.rehydrate_snapshot('tenant-1', 'snap-1', source_target);

    expect(result.status).toBe(ReplicationStatus.COMPLETED);
    expect(result.objects_copied).toBe(0);
  });

  it('rehydrate_tenant copies all missing snapshots from source', async () => {
    const m1 = make_manifest('snap-1', 'mbx-1', []);
    const m2 = make_manifest('snap-2', 'mbx-2', []);

    vi.mocked(manifests.list_all_manifests).mockImplementation(async (ctx) => {
      if (ctx === target_ctx) return [m1, m2];
      return [];
    });
    vi.mocked(source_storage.exists).mockResolvedValue(false);
    vi.mocked(target_storage.exists).mockResolvedValue(false);
    vi.mocked(source_storage.get).mockResolvedValue(Buffer.from('data'));
    vi.mocked(target_storage.get).mockResolvedValue(Buffer.from('data'));

    const source_target: StorageTarget = {
      target_id: 'offsite',
      endpoint: 'http://offsite:9000',
      create_context: vi.fn().mockResolvedValue(target_ctx),
    };

    const result = await service.rehydrate_tenant('tenant-1', source_target);

    expect(result.status).toBe(ReplicationStatus.COMPLETED);
  });

  it('get_replication_status returns empty when no sidecars exist', async () => {
    vi.mocked(source_storage.list).mockResolvedValue([]);

    const results = await service.get_replication_status('tenant-1');

    expect(results).toEqual([]);
  });
});
