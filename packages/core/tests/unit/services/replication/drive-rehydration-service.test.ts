import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AtlasConfig } from '@/utils/config';
import type {
  OneDriveManifestRepository,
  SharePointManifestRepository,
  StorageTarget,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveReplicationService } from '@/services/replication/onedrive-replication.service';
import { SharePointReplicationService } from '@/services/replication/sharepoint-replication.service';
import { stub_storage_target } from '@wisecom/atlas-types/testing/stub-storage-target';

/**
 * Issue #191: the drive replication services sat at 25% and 50% branch coverage, and the
 * disaster-recovery entry points were the untested part. These cover the three decisions a
 * rehydration makes before it copies anything: is the source DEK on the primary, does the snapshot
 * already exist here, and does the snapshot exist on the replica at all.
 */
vi.mock('@/services/replication/rehydration-dek-helper', () => ({
  ensure_source_dek_on_primary: vi.fn(async () => undefined),
  DekOverwriteRefusedError: class extends Error {},
}));
vi.mock('@/services/replication/onedrive-snapshot-copier', () => ({
  copy_onedrive_snapshot_between: vi.fn(async () => ({ snapshot_id: 'snap-1', copied: true })),
  copy_onedrive_snapshot_to_target: vi.fn(),
  copy_onedrive_snapshot_into_context: vi.fn(),
}));
vi.mock('@/services/replication/sharepoint-snapshot-copier', () => ({
  copy_sharepoint_snapshot_between: vi.fn(async () => ({ snapshot_id: 'snap-1', copied: true })),
  copy_sharepoint_snapshot_to_target: vi.fn(),
  copy_sharepoint_snapshot_into_context: vi.fn(),
}));

import { ensure_source_dek_on_primary } from '@/services/replication/rehydration-dek-helper';
import { copy_onedrive_snapshot_between } from '@/services/replication/onedrive-snapshot-copier';
import { copy_sharepoint_snapshot_between } from '@/services/replication/sharepoint-snapshot-copier';

const CONFIG = { encryption_passphrase: 'p' } as unknown as AtlasConfig;
const OD_KEY = 'onedrive/manifests/owner-1/snap-1.json';
const SP_KEY = 'sharepoint/manifests/site-1/snap-1.json';

/** Primary context whose bucket holds the given keys. */
function make_primary(existing: string[]): { ctx: TenantContext; destroyed: () => number } {
  let destroyed = 0;
  const ctx = {
    tenant_id: 't',
    storage: { exists: async (key: string) => existing.includes(key) },
    destroy: () => {
      destroyed++;
    },
  } as unknown as TenantContext;
  return { ctx, destroyed: () => destroyed };
}

describe('drive rehydration entry points', () => {
  let primary: ReturnType<typeof make_primary>;
  let tenant_factory: TenantContextFactory;
  let target_factory: () => StorageTarget;

  beforeEach(() => {
    vi.mocked(ensure_source_dek_on_primary).mockClear();
    vi.mocked(copy_onedrive_snapshot_between).mockClear();
    vi.mocked(copy_sharepoint_snapshot_between).mockClear();
    primary = make_primary([]);
    tenant_factory = { create: vi.fn(async () => primary.ctx) } as unknown as TenantContextFactory;
    target_factory = (() => stub_storage_target({ target_id: 'primary' }).target) as never;
  });

  function od_service(manifest: unknown): OneDriveReplicationService {
    const repo = {
      find_by_snapshot: vi.fn(async () => manifest),
    } as unknown as OneDriveManifestRepository;
    return new OneDriveReplicationService(
      tenant_factory,
      repo,
      CONFIG,
      vi.fn(async () => undefined),
      target_factory as never,
    );
  }

  function sp_service(manifest: unknown): SharePointReplicationService {
    const repo = {
      find_by_snapshot: vi.fn(async () => manifest),
    } as unknown as SharePointManifestRepository;
    return new SharePointReplicationService(
      tenant_factory,
      repo,
      CONFIG,
      vi.fn(async () => undefined),
      target_factory as never,
    );
  }

  describe('OneDrive', () => {
    const manifest = { snapshot_id: 'snap-1', owner_id: 'owner-1', entries: [{}, {}] };

    it('ensures the source DEK on the primary before reading any object', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await od_service(manifest).rehydrate_owner_snapshot('t', 'owner-1', 'snap-1', replica.target);

      expect(ensure_source_dek_on_primary).toHaveBeenCalledTimes(1);
    });

    it('reports a skip instead of copying when the primary already holds the snapshot', async () => {
      primary = make_primary([OD_KEY]);
      tenant_factory = {
        create: vi.fn(async () => primary.ctx),
      } as unknown as TenantContextFactory;
      const replica = stub_storage_target({ target_id: 'replica' });

      const result = await od_service(manifest).rehydrate_owner_snapshot(
        't',
        'owner-1',
        'snap-1',
        replica.target,
      );

      expect(copy_onedrive_snapshot_between).not.toHaveBeenCalled();
      expect(result.objects_skipped).toBe(manifest.entries.length);
    });

    it('copies when the primary does not hold it yet', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await od_service(manifest).rehydrate_owner_snapshot('t', 'owner-1', 'snap-1', replica.target);

      expect(copy_onedrive_snapshot_between).toHaveBeenCalledTimes(1);
    });

    it('raises when the replica has no such manifest, rather than reporting an empty success', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await expect(
        od_service(undefined).rehydrate_owner_snapshot('t', 'owner-1', 'snap-1', replica.target),
      ).rejects.toThrow(/No OneDrive manifest found/);
    });

    it('destroys both contexts on the success path and on the throwing one', async () => {
      const ok_replica = stub_storage_target({ target_id: 'replica' });
      await od_service(manifest).rehydrate_owner_snapshot(
        't',
        'owner-1',
        'snap-1',
        ok_replica.target,
      );
      expect(ok_replica.destroyed()).toBe(ok_replica.created());
      expect(primary.destroyed()).toBe(1);

      primary = make_primary([]);
      tenant_factory = {
        create: vi.fn(async () => primary.ctx),
      } as unknown as TenantContextFactory;
      const bad_replica = stub_storage_target({ target_id: 'replica' });
      await expect(
        od_service(undefined).rehydrate_owner_snapshot(
          't',
          'owner-1',
          'snap-1',
          bad_replica.target,
        ),
      ).rejects.toThrow();
      expect(bad_replica.destroyed()).toBe(bad_replica.created());
      expect(primary.destroyed()).toBe(1);
    });
  });

  describe('SharePoint', () => {
    const manifest = { snapshot_id: 'snap-1', site_id: 'site-1', entries: [{}, {}] };

    it('ensures the source DEK on the primary before reading any object', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await sp_service(manifest).rehydrate_site_snapshot('t', 'site-1', 'snap-1', replica.target);

      expect(ensure_source_dek_on_primary).toHaveBeenCalledTimes(1);
    });

    it('reports a skip instead of copying when the primary already holds the snapshot', async () => {
      primary = make_primary([SP_KEY]);
      tenant_factory = {
        create: vi.fn(async () => primary.ctx),
      } as unknown as TenantContextFactory;
      const replica = stub_storage_target({ target_id: 'replica' });

      const result = await sp_service(manifest).rehydrate_site_snapshot(
        't',
        'site-1',
        'snap-1',
        replica.target,
      );

      expect(copy_sharepoint_snapshot_between).not.toHaveBeenCalled();
      expect(result.objects_skipped).toBe(manifest.entries.length);
    });

    it('copies when the primary does not hold it yet', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await sp_service(manifest).rehydrate_site_snapshot('t', 'site-1', 'snap-1', replica.target);

      expect(copy_sharepoint_snapshot_between).toHaveBeenCalledTimes(1);
    });

    it('raises when the replica has no such manifest', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await expect(
        sp_service(undefined).rehydrate_site_snapshot('t', 'site-1', 'snap-1', replica.target),
      ).rejects.toThrow(/manifest/i);
    });

    it('destroys both contexts on the throwing path', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await expect(
        sp_service(undefined).rehydrate_site_snapshot('t', 'site-1', 'snap-1', replica.target),
      ).rejects.toThrow();

      expect(replica.destroyed()).toBe(replica.created());
      expect(primary.destroyed()).toBe(1);
    });
  });
});

/**
 * `rehydrate_owner` / `rehydrate_site` recover every snapshot for one scope, and were the last
 * untested branch of these services. They delegate the per-manifest work to the runners, so what
 * matters here is that the DEK is settled first and both contexts are closed either way.
 */
describe('whole-scope rehydration', () => {
  let primary: ReturnType<typeof make_primary>;
  let tenant_factory: TenantContextFactory;
  let target_factory: () => StorageTarget;

  beforeEach(() => {
    vi.mocked(ensure_source_dek_on_primary).mockClear();
    primary = make_primary([]);
    tenant_factory = { create: vi.fn(async () => primary.ctx) } as unknown as TenantContextFactory;
    target_factory = (() => stub_storage_target({ target_id: 'primary' }).target) as never;
  });

  it('rehydrate_owner settles the DEK first and closes both contexts', async () => {
    const replica = stub_storage_target({ target_id: 'replica' });
    const repo = {
      list_snapshots_by_owner: vi.fn(async () => []),
    } as unknown as OneDriveManifestRepository;
    const service = new OneDriveReplicationService(
      tenant_factory,
      repo,
      CONFIG,
      vi.fn(async () => undefined),
      target_factory as never,
    );

    await service.rehydrate_owner('t', 'owner-1', replica.target);

    expect(ensure_source_dek_on_primary).toHaveBeenCalledTimes(1);
    expect(replica.destroyed()).toBe(replica.created());
    expect(primary.destroyed()).toBe(1);
  });

  it('rehydrate_site settles the DEK first and closes both contexts', async () => {
    const replica = stub_storage_target({ target_id: 'replica' });
    const repo = {
      list_snapshots_by_site: vi.fn(async () => []),
    } as unknown as SharePointManifestRepository;
    const service = new SharePointReplicationService(
      tenant_factory,
      repo,
      CONFIG,
      vi.fn(async () => undefined),
      target_factory as never,
    );

    await service.rehydrate_site('t', 'site-1', replica.target);

    expect(ensure_source_dek_on_primary).toHaveBeenCalledTimes(1);
    expect(replica.destroyed()).toBe(replica.created());
    expect(primary.destroyed()).toBe(1);
  });

  it('closes both contexts when listing the replica throws', async () => {
    const replica = stub_storage_target({ target_id: 'replica' });
    const repo = {
      list_snapshots_by_owner: vi.fn(() => {
        throw new Error('replica unreachable');
      }),
    } as unknown as OneDriveManifestRepository;
    const service = new OneDriveReplicationService(
      tenant_factory,
      repo,
      CONFIG,
      vi.fn(async () => undefined),
      target_factory as never,
    );

    await expect(service.rehydrate_owner('t', 'owner-1', replica.target)).rejects.toThrow(
      'replica unreachable',
    );

    expect(replica.destroyed()).toBe(replica.created());
    expect(primary.destroyed()).toBe(1);
  });
});
