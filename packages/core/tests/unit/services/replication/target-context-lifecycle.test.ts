import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OneDriveReplicationService } from '@/services/replication/onedrive-replication.service';
import { SharePointReplicationService } from '@/services/replication/sharepoint-replication.service';
import { stub_storage_target } from '@wisecom/atlas-types/testing/stub-storage-target';
import type { AtlasConfig } from '@/utils/config';
import type {
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  SharePointManifestRepository,
  SharePointSnapshotManifest,
  StorageTargetFactory,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';

/**
 * Issue #200: every drive snapshot copy built a target TenantContext and never
 * destroyed it, on the success path and on every throw path alike. The context
 * owns an EnvelopeKeyService derived from the target passphrase and `destroy()`
 * is what zeroes it, so the material was left for garbage collection instead of
 * the explicit cleanup the port promises.
 *
 * Counting creates against destroys is the only way to see this from the
 * outside, since a leaked context changes no output.
 */
vi.mock('@/services/replication/drive-snapshot-replicator', () => ({
  replicate_drive_snapshot_objects: vi.fn(async () => ({
    objects_copied: 1,
    bytes_copied: 10,
    objects_skipped: 0,
    objects_failed: 0,
    manifests_copied: 1,
    errors: [],
  })),
}));

vi.mock('@/services/replication/replication-status-repository', () => ({
  save_replication_status: vi.fn(async () => undefined),
  load_replicated_snapshot_ids: vi.fn(async () => new Set<string>()),
}));

const CONFIG = { encryption_passphrase: 'p' } as unknown as AtlasConfig;

function make_source_context(): { ctx: TenantContext; destroyed: () => number } {
  let destroyed = 0;
  const ctx = {
    tenant_id: 't',
    storage: {
      exists: async () => false,
      get: async () => Buffer.alloc(0),
      put: async () => undefined,
      list: async () => [],
    },
    destroy: () => {
      destroyed++;
    },
  } as unknown as TenantContext;
  return { ctx, destroyed: () => destroyed };
}

function onedrive_manifest(snapshot_id: string): OneDriveSnapshotManifest {
  return { snapshot_id, owner_id: 'owner-1', sealed: true } as unknown as OneDriveSnapshotManifest;
}

function sharepoint_manifest(snapshot_id: string): SharePointSnapshotManifest {
  return { snapshot_id, site_id: 'site-1', sealed: true } as unknown as SharePointSnapshotManifest;
}

describe('drive replication target context lifecycle', () => {
  let source: ReturnType<typeof make_source_context>;
  let tenant_factory: TenantContextFactory;
  let target_factory: StorageTargetFactory;

  beforeEach(() => {
    source = make_source_context();
    tenant_factory = { create: vi.fn(async () => source.ctx) } as unknown as TenantContextFactory;
    target_factory = {} as unknown as StorageTargetFactory;
  });

  describe('OneDrive', () => {
    function make_service(manifests: OneDriveSnapshotManifest[]): OneDriveReplicationService {
      const repo = {
        list_snapshots_by_owner: vi.fn(async () => manifests),
        list_all_manifests: vi.fn(async () => manifests),
        find_by_snapshot: vi.fn(async () => manifests[0]),
      } as unknown as OneDriveManifestRepository;
      return new OneDriveReplicationService(
        tenant_factory,
        repo,
        CONFIG,
        vi.fn(async () => undefined),
        target_factory,
      );
    }

    it('destroys the target context after a successful copy', async () => {
      const stub = stub_storage_target();
      const service = make_service([onedrive_manifest('od-1')]);

      await service.replicate_owner('t', 'owner-1', 'od-1', [stub.target]);

      expect(stub.created()).toBe(1);
      expect(stub.destroyed()).toBe(1);
    });

    it('destroys the target context when DEK validation throws', async () => {
      const stub = stub_storage_target();
      const repo = {
        find_by_snapshot: vi.fn(async () => onedrive_manifest('od-1')),
      } as unknown as OneDriveManifestRepository;
      const service = new OneDriveReplicationService(
        tenant_factory,
        repo,
        CONFIG,
        vi.fn(() => {
          throw Object.assign(new Error('DEK mismatch'), { name: 'DekMismatchError' });
        }),
        target_factory,
      );

      await expect(service.replicate_owner('t', 'owner-1', 'od-1', [stub.target])).rejects.toThrow(
        'DEK mismatch',
      );

      expect(stub.created()).toBe(1);
      expect(stub.destroyed()).toBe(1);
    });

    it('balances creates and destroys across several snapshots and targets', async () => {
      const a = stub_storage_target({ target_id: 'a' });
      const b = stub_storage_target({ target_id: 'b' });
      const service = make_service([onedrive_manifest('od-1'), onedrive_manifest('od-2')]);

      await service.replicate_all_owner_snapshots('t', 'owner-1', [a.target, b.target]);

      expect(a.created()).toBeGreaterThan(0);
      expect(a.destroyed()).toBe(a.created());
      expect(b.destroyed()).toBe(b.created());
    });
  });

  describe('SharePoint', () => {
    function make_service(manifests: SharePointSnapshotManifest[]): SharePointReplicationService {
      const repo = {
        list_snapshots_by_site: vi.fn(async () => manifests),
        list_all_manifests: vi.fn(async () => manifests),
        find_by_snapshot: vi.fn(async () => manifests[0]),
      } as unknown as SharePointManifestRepository;
      return new SharePointReplicationService(
        tenant_factory,
        repo,
        CONFIG,
        vi.fn(async () => undefined),
        target_factory,
      );
    }

    it('destroys the target context after a successful copy', async () => {
      const stub = stub_storage_target();
      const service = make_service([sharepoint_manifest('sp-1')]);

      await service.replicate_site('t', 'site-1', 'sp-1', [stub.target]);

      expect(stub.created()).toBe(1);
      expect(stub.destroyed()).toBe(1);
    });

    it('destroys the target context when DEK validation throws', async () => {
      const stub = stub_storage_target();
      const repo = {
        find_by_snapshot: vi.fn(async () => sharepoint_manifest('sp-1')),
      } as unknown as SharePointManifestRepository;
      const service = new SharePointReplicationService(
        tenant_factory,
        repo,
        CONFIG,
        vi.fn(() => {
          throw Object.assign(new Error('DEK mismatch'), { name: 'DekMismatchError' });
        }),
        target_factory,
      );

      await expect(service.replicate_site('t', 'site-1', 'sp-1', [stub.target])).rejects.toThrow(
        'DEK mismatch',
      );

      expect(stub.created()).toBe(1);
      expect(stub.destroyed()).toBe(1);
    });

    it('balances creates and destroys across several snapshots and targets', async () => {
      const a = stub_storage_target({ target_id: 'a' });
      const b = stub_storage_target({ target_id: 'b' });
      const service = make_service([sharepoint_manifest('sp-1'), sharepoint_manifest('sp-2')]);

      await service.replicate_all_site_snapshots('t', 'site-1', [a.target, b.target]);

      expect(a.created()).toBeGreaterThan(0);
      expect(a.destroyed()).toBe(a.created());
      expect(b.destroyed()).toBe(b.created());
    });
  });
});

/**
 * Issue #206: the per-target loop already opened a context for the manifest diff, then every
 * snapshot copy opened another one. Each open unwraps the tenant DEK, and each DEK validation
 * unwraps two, so a run paid three scrypt derivations per snapshot at N=65536 instead of one per
 * target.
 */
describe('drive replication context reuse', () => {
  let source: ReturnType<typeof make_source_context>;
  let tenant_factory: TenantContextFactory;
  let target_factory: StorageTargetFactory;

  beforeEach(() => {
    source = make_source_context();
    tenant_factory = { create: vi.fn(async () => source.ctx) } as unknown as TenantContextFactory;
    target_factory = {} as unknown as StorageTargetFactory;
  });

  it('opens one OneDrive target context per target, not per snapshot', async () => {
    const stub = stub_storage_target();
    const manifests = [
      onedrive_manifest('od-1'),
      onedrive_manifest('od-2'),
      onedrive_manifest('od-3'),
    ];
    const repo = {
      list_snapshots_by_owner: vi.fn(async () => manifests),
    } as unknown as OneDriveManifestRepository;
    const validate_dek = vi.fn(async () => undefined);
    const service = new OneDriveReplicationService(
      tenant_factory,
      repo,
      CONFIG,
      validate_dek,
      target_factory,
    );

    await service.replicate_all_owner_snapshots('t', 'owner-1', [stub.target]);

    expect(stub.created()).toBe(1);
    expect(stub.destroyed()).toBe(1);
    expect(validate_dek).toHaveBeenCalledTimes(1);
  });

  it('opens one SharePoint target context per target, not per snapshot', async () => {
    const stub = stub_storage_target();
    const manifests = [
      sharepoint_manifest('sp-1'),
      sharepoint_manifest('sp-2'),
      sharepoint_manifest('sp-3'),
    ];
    const repo = {
      list_snapshots_by_site: vi.fn(async () => manifests),
    } as unknown as SharePointManifestRepository;
    const validate_dek = vi.fn(async () => undefined);
    const service = new SharePointReplicationService(
      tenant_factory,
      repo,
      CONFIG,
      validate_dek,
      target_factory,
    );

    await service.replicate_all_site_snapshots('t', 'site-1', [stub.target]);

    expect(stub.created()).toBe(1);
    expect(stub.destroyed()).toBe(1);
    expect(validate_dek).toHaveBeenCalledTimes(1);
  });

  it('opens one context per target when there are several targets', async () => {
    const a = stub_storage_target({ target_id: 'a' });
    const b = stub_storage_target({ target_id: 'b' });
    const repo = {
      list_snapshots_by_owner: vi.fn(async () => [
        onedrive_manifest('od-1'),
        onedrive_manifest('od-2'),
      ]),
    } as unknown as OneDriveManifestRepository;
    const validate_dek = vi.fn(async () => undefined);
    const service = new OneDriveReplicationService(
      tenant_factory,
      repo,
      CONFIG,
      validate_dek,
      target_factory,
    );

    await service.replicate_all_owner_snapshots('t', 'owner-1', [a.target, b.target]);

    expect(a.created()).toBe(1);
    expect(b.created()).toBe(1);
    expect(validate_dek).toHaveBeenCalledTimes(2);
  });

  it('still opens one context for the diff when nothing is missing', async () => {
    // The negative case: no snapshots to copy must not mean no context, since the diff needs one,
    // and must not mean one per manifest either.
    const stub = stub_storage_target();
    const repo = {
      list_snapshots_by_owner: vi.fn(async () => []),
    } as unknown as OneDriveManifestRepository;
    const service = new OneDriveReplicationService(
      tenant_factory,
      repo,
      CONFIG,
      vi.fn(async () => undefined),
      target_factory,
    );

    await service.replicate_all_owner_snapshots('t', 'owner-1', [stub.target]);

    expect(stub.created()).toBe(1);
    expect(stub.destroyed()).toBe(1);
  });

  it('destroys the reused context exactly once when a copy fails mid-loop', async () => {
    const stub = stub_storage_target();
    const repo = {
      list_snapshots_by_owner: vi.fn(async () => [
        onedrive_manifest('od-1'),
        onedrive_manifest('od-2'),
      ]),
    } as unknown as OneDriveManifestRepository;
    const service = new OneDriveReplicationService(
      tenant_factory,
      repo,
      CONFIG,
      vi.fn(() => {
        throw new Error('validation blew up');
      }),
      target_factory,
    );

    await expect(
      service.replicate_all_owner_snapshots('t', 'owner-1', [stub.target]),
    ).rejects.toThrow('validation blew up');

    expect(stub.created()).toBe(1);
    expect(stub.destroyed()).toBe(1);
  });
});
