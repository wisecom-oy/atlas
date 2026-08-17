import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplicationService } from '@/services/replication/replication.service';
import { ReplicationStatus } from '@wisecom/atlas-types';
import type {
  TenantContext,
  TenantContextFactory,
  ManifestRepository,
  ObjectStorage,
  StorageTarget,
  StorageTargetFactory,
  DekValidationFn,
  OneDriveReplicationUseCase,
  SharePointReplicationUseCase,
} from '@wisecom/atlas-types';
import {
  TEST_CONFIG,
  make_ctx,
  make_dek_validator,
  make_entry,
  make_manifest,
  make_manifest_repository,
  make_onedrive_replication_mock,
  make_sharepoint_replication_mock,
  make_storage,
  make_storage_target,
} from './replication-fixtures';

vi.mock('@/services/replication/rehydration-dek-helper', () => ({
  ensure_source_dek_on_primary: vi.fn().mockResolvedValue(undefined),
}));

describe('ReplicationService', () => {
  let source_storage: ObjectStorage;
  let target_storage: ObjectStorage;
  let source_ctx: TenantContext;
  let target_ctx: TenantContext;
  let tenant_factory: TenantContextFactory;
  let manifests: ManifestRepository;
  let target: StorageTarget;
  let validate_dek: DekValidationFn;
  let target_factory: StorageTargetFactory;
  let onedrive_replication: OneDriveReplicationUseCase;
  let sharepoint_replication: SharePointReplicationUseCase;
  let service: ReplicationService;

  beforeEach(() => {
    source_storage = make_storage();
    target_storage = make_storage();
    source_ctx = make_ctx(source_storage);
    target_ctx = make_ctx(target_storage);
    tenant_factory = { create: vi.fn().mockResolvedValue(source_ctx) };
    manifests = make_manifest_repository();
    target = make_storage_target('offsite', target_ctx);
    validate_dek = make_dek_validator();
    target_factory = vi.fn().mockReturnValue(target) as unknown as StorageTargetFactory;
    onedrive_replication = make_onedrive_replication_mock();
    sharepoint_replication = make_sharepoint_replication_mock();
    service = new ReplicationService(
      tenant_factory,
      manifests,
      TEST_CONFIG,
      validate_dek,
      target_factory,
      onedrive_replication,
      sharepoint_replication,
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

  it('get_replication_status returns empty when no sidecars exist', async () => {
    vi.mocked(source_storage.list).mockResolvedValue([]);

    const results = await service.get_replication_status('tenant-1');

    expect(results).toEqual([]);
  });

  it('get_replication_status_by_owner lowercases the owner id used as the sidecar prefix', async () => {
    vi.mocked(source_storage.list).mockResolvedValue([]);

    await service.get_replication_status_by_owner('tenant-1', 'User@Company.COM');

    expect(source_storage.list).toHaveBeenCalledWith('_meta/replication/user@company.com/');
  });
});
