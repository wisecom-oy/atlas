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
vi.mock('@/services/replication/dek-rehydration-validator', () => ({
  ensure_source_dek_on_primary: vi.fn(async () => undefined),
  DekOverwriteRefusedError: class extends Error {},
}));
vi.mock('@/services/replication/drive-snapshot-replicator', () => ({
  replicate_drive_snapshot_objects: vi.fn(async () => ({
    objects_copied: 2,
    objects_skipped: 0,
    objects_failed: 0,
    bytes_copied: 20,
    errors: [],
  })),
}));

import { ensure_source_dek_on_primary } from '@/services/replication/dek-rehydration-validator';
import { replicate_drive_snapshot_objects } from '@/services/replication/drive-snapshot-replicator';

const CONFIG = { encryption_passphrase: 'p' } as unknown as AtlasConfig;
const ONEDRIVE_KEY = 'onedrive/manifests/owner-1/snap-1.json';
const SHAREPOINT_KEY = 'sharepoint/manifests/site-1/snap-1.json';

/** A summary index with no rows: the snapshot's chain is the snapshot alone. */
const NO_OLDER_SNAPSHOTS = { summaries: [], unreadable_keys: [] };

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
    vi.mocked(replicate_drive_snapshot_objects).mockClear();
    primary = make_primary([]);
    tenant_factory = { create: vi.fn(async () => primary.ctx) } as unknown as TenantContextFactory;
    target_factory = (() => stub_storage_target({ target_id: 'primary' }).target) as never;
  });

  function onedrive_service(manifest: unknown): OneDriveReplicationService {
    const repo = {
      find_by_snapshot: vi.fn(async () => manifest),
      list_snapshot_summaries: vi.fn(async () => NO_OLDER_SNAPSHOTS),
    } as unknown as OneDriveManifestRepository;
    return new OneDriveReplicationService(
      tenant_factory,
      repo,
      CONFIG,
      vi.fn(async () => undefined),
      target_factory as never,
    );
  }

  function sharepoint_service(manifest: unknown): SharePointReplicationService {
    const repo = {
      find_by_snapshot: vi.fn(async () => manifest),
      list_snapshot_summaries: vi.fn(async () => NO_OLDER_SNAPSHOTS),
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
    const manifest = {
      snapshot_id: 'snap-1',
      owner_id: 'owner-1',
      created_at: new Date(0),
      entries: [{}, {}],
    };

    it('ensures the source DEK on the primary before reading any object', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await onedrive_service(manifest).rehydrate_owner_snapshot(
        't',
        'owner-1',
        'snap-1',
        replica.target,
      );

      expect(ensure_source_dek_on_primary).toHaveBeenCalledTimes(1);
    });

    it('reports a skip instead of copying when the primary already holds the snapshot', async () => {
      primary = make_primary([ONEDRIVE_KEY]);
      tenant_factory = {
        create: vi.fn(async () => primary.ctx),
      } as unknown as TenantContextFactory;
      const replica = stub_storage_target({ target_id: 'replica' });

      const result = await onedrive_service(manifest).rehydrate_owner_snapshot(
        't',
        'owner-1',
        'snap-1',
        replica.target,
      );

      expect(replicate_drive_snapshot_objects).not.toHaveBeenCalled();
      expect(result.objects_skipped).toBe(manifest.entries.length);
    });

    it('copies when the primary does not hold it yet', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await onedrive_service(manifest).rehydrate_owner_snapshot(
        't',
        'owner-1',
        'snap-1',
        replica.target,
      );

      expect(replicate_drive_snapshot_objects).toHaveBeenCalledTimes(1);
    });

    it('raises when the replica has no such manifest, rather than reporting an empty success', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await expect(
        onedrive_service(undefined).rehydrate_owner_snapshot(
          't',
          'owner-1',
          'snap-1',
          replica.target,
        ),
      ).rejects.toThrow(/No OneDrive manifest found/);
    });

    it('destroys both contexts on the success path and on the throwing one', async () => {
      const ok_replica = stub_storage_target({ target_id: 'replica' });
      await onedrive_service(manifest).rehydrate_owner_snapshot(
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
        onedrive_service(undefined).rehydrate_owner_snapshot(
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
    const manifest = {
      snapshot_id: 'snap-1',
      site_id: 'site-1',
      created_at: new Date(0),
      entries: [{}, {}],
    };

    it('ensures the source DEK on the primary before reading any object', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await sharepoint_service(manifest).rehydrate_site_snapshot(
        't',
        'site-1',
        'snap-1',
        replica.target,
      );

      expect(ensure_source_dek_on_primary).toHaveBeenCalledTimes(1);
    });

    it('reports a skip instead of copying when the primary already holds the snapshot', async () => {
      primary = make_primary([SHAREPOINT_KEY]);
      tenant_factory = {
        create: vi.fn(async () => primary.ctx),
      } as unknown as TenantContextFactory;
      const replica = stub_storage_target({ target_id: 'replica' });

      const result = await sharepoint_service(manifest).rehydrate_site_snapshot(
        't',
        'site-1',
        'snap-1',
        replica.target,
      );

      expect(replicate_drive_snapshot_objects).not.toHaveBeenCalled();
      expect(result.objects_skipped).toBe(manifest.entries.length);
    });

    it('copies when the primary does not hold it yet', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await sharepoint_service(manifest).rehydrate_site_snapshot(
        't',
        'site-1',
        'snap-1',
        replica.target,
      );

      expect(replicate_drive_snapshot_objects).toHaveBeenCalledTimes(1);
    });

    it('raises when the replica has no such manifest', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await expect(
        sharepoint_service(undefined).rehydrate_site_snapshot(
          't',
          'site-1',
          'snap-1',
          replica.target,
        ),
      ).rejects.toThrow(/manifest/i);
    });

    it('destroys both contexts on the throwing path', async () => {
      const replica = stub_storage_target({ target_id: 'replica' });

      await expect(
        sharepoint_service(undefined).rehydrate_site_snapshot(
          't',
          'site-1',
          'snap-1',
          replica.target,
        ),
      ).rejects.toThrow();

      expect(replica.destroyed()).toBe(replica.created());
      expect(primary.destroyed()).toBe(1);
    });
  });
});
