import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplicationService } from '@/services/replication/replication.service';
import { ReplicationStatus } from '@wisecom/atlas-types';
import type {
  DekValidationFn,
  ManifestRepository,
  ObjectStorage,
  OneDriveReplicationUseCase,
  SharePointReplicationUseCase,
  StorageTarget,
  StorageTargetFactory,
  TenantContext,
  TenantContextFactory,
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
  make_workload_result,
} from './replication-fixtures';

vi.mock('@/services/replication/rehydration-dek-helper', () => ({
  ensure_source_dek_on_primary: vi.fn().mockResolvedValue(undefined),
}));

describe('ReplicationService tenant scope', () => {
  let primary_storage: ObjectStorage;
  let remote_storage: ObjectStorage;
  let primary_ctx: TenantContext;
  let remote_ctx: TenantContext;
  let tenant_factory: TenantContextFactory;
  let manifests: ManifestRepository;
  let validate_dek: DekValidationFn;
  let target_factory: StorageTargetFactory;
  let onedrive: OneDriveReplicationUseCase;
  let sharepoint: SharePointReplicationUseCase;
  let remote: StorageTarget;
  let service: ReplicationService;

  beforeEach(() => {
    primary_storage = make_storage();
    remote_storage = make_storage();
    primary_ctx = make_ctx(primary_storage);
    remote_ctx = make_ctx(remote_storage);
    tenant_factory = { create: vi.fn().mockResolvedValue(primary_ctx) };
    manifests = make_manifest_repository();
    validate_dek = make_dek_validator();
    remote = make_storage_target('offsite', remote_ctx);
    target_factory = vi.fn().mockReturnValue(remote) as unknown as StorageTargetFactory;
    onedrive = make_onedrive_replication_mock();
    sharepoint = make_sharepoint_replication_mock();
    service = new ReplicationService(
      tenant_factory,
      manifests,
      TEST_CONFIG,
      validate_dek,
      target_factory,
      onedrive,
      sharepoint,
    );
  });

  it('replicate_tenant pushes every mailbox plus OneDrive and SharePoint', async () => {
    const m1 = make_manifest('snap-1', 'mbx-1', [make_entry('a')]);
    const m2 = make_manifest('snap-2', 'mbx-2', [make_entry('b')]);

    vi.mocked(manifests.list_all_manifests).mockResolvedValue([m1, m2]);
    vi.mocked(remote_storage.list).mockResolvedValue([]);
    vi.mocked(primary_storage.get).mockResolvedValue(Buffer.from('data'));
    vi.mocked(remote_storage.get).mockResolvedValue(Buffer.from('data'));
    vi.mocked(onedrive.replicate_all_owners).mockResolvedValue([
      make_workload_result('od-snap-1', 5, 500),
    ]);
    vi.mocked(sharepoint.replicate_all_sites).mockResolvedValue([
      make_workload_result('sp-snap-1', 9, 900),
      make_workload_result('sp-snap-2', 4, 400),
    ]);

    const result = await service.replicate_tenant('tenant-1', [remote]);

    expect(onedrive.replicate_all_owners).toHaveBeenCalledWith('tenant-1', [remote]);
    expect(sharepoint.replicate_all_sites).toHaveBeenCalledWith('tenant-1', [remote]);
    const by_workload = new Map(result.workloads.map((w) => [w.workload, w.result]));
    // Both mailboxes are enumerated from the manifest root, not just the first.
    expect(by_workload.get('outlook')?.objects_copied).toBe(2);
    expect(by_workload.get('onedrive')?.objects_copied).toBe(5);
    expect(by_workload.get('sharepoint')?.objects_copied).toBe(13);
    expect(result.total.objects_copied).toBe(20);
    expect(result.total.status).toBe(ReplicationStatus.COMPLETED);
  });

  it('replicate_tenant reports every workload even when nothing is replicated', async () => {
    vi.mocked(manifests.list_all_manifests).mockResolvedValue([]);

    const result = await service.replicate_tenant('tenant-1', [remote]);

    expect(result.workloads.map((w) => w.workload)).toEqual(['outlook', 'onedrive', 'sharepoint']);
    expect(result.total.objects_copied).toBe(0);
  });

  it('rehydrate_tenant recovers Outlook, OneDrive, and SharePoint, not Outlook alone', async () => {
    const m1 = make_manifest('snap-1', 'mbx-1', []);
    const m2 = make_manifest('snap-2', 'mbx-2', []);

    vi.mocked(manifests.list_all_manifests).mockImplementation(async (ctx) => {
      if (ctx === remote_ctx) return [m1, m2];
      return [];
    });
    vi.mocked(primary_storage.get).mockResolvedValue(Buffer.from('data'));
    vi.mocked(remote_storage.get).mockResolvedValue(Buffer.from('data'));
    vi.mocked(onedrive.rehydrate_all_owners).mockResolvedValue(
      make_workload_result('2-owners', 7, 700),
    );
    vi.mocked(sharepoint.rehydrate_all_sites).mockResolvedValue(
      make_workload_result('1-sites', 59, 5900),
    );

    const result = await service.rehydrate_tenant('tenant-1', remote);

    expect(onedrive.rehydrate_all_owners).toHaveBeenCalledWith('tenant-1', remote);
    expect(sharepoint.rehydrate_all_sites).toHaveBeenCalledWith('tenant-1', remote);
    expect(result.workloads.map((w) => w.workload)).toEqual(['outlook', 'onedrive', 'sharepoint']);
    expect(result.total.status).toBe(ReplicationStatus.COMPLETED);
    const by_workload = new Map(result.workloads.map((w) => [w.workload, w.result]));
    expect(by_workload.get('onedrive')?.objects_copied).toBe(7);
    expect(by_workload.get('sharepoint')?.objects_copied).toBe(59);
    expect(result.total.objects_copied).toBe(by_workload.get('outlook')!.objects_copied + 7 + 59);
    expect(result.total.bytes_copied).toBe(by_workload.get('outlook')!.bytes_copied + 700 + 5900);
  });

  it('rehydrate_tenant reports a workload that failed without hiding it in the aggregate', async () => {
    vi.mocked(manifests.list_all_manifests).mockResolvedValue([]);
    vi.mocked(onedrive.rehydrate_all_owners).mockResolvedValue({
      ...make_workload_result('1-owners', 0, 0),
      status: ReplicationStatus.FAILED,
      objects_failed: 3,
      objects_total: 3,
      errors: ['onedrive/data/owner/abc: access denied'],
    });

    const result = await service.rehydrate_tenant('tenant-1', remote);

    expect(result.total.status).not.toBe(ReplicationStatus.COMPLETED);
    expect(result.total.objects_failed).toBe(3);
    expect(result.total.errors).toContain('onedrive/data/owner/abc: access denied');
  });
});
