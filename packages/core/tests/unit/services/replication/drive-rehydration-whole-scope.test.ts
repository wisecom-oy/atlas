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
 * `rehydrate_owner` / `rehydrate_site` recover every snapshot for one scope, and were the last
 * untested branch of these services. They delegate the per-manifest work to the runners, so what
 * matters here is that the DEK is settled first and both contexts are closed either way.
 */
vi.mock('@/services/replication/dek-rehydration-validator', () => ({
  ensure_source_dek_on_primary: vi.fn(async () => undefined),
}));
vi.mock('@/services/replication/rehydration-manifests-runner', () => ({
  rehydrate_manifests: vi.fn(async () => ({ snapshot_id: 'snap-1', objects_copied: 0 })),
}));

import { ensure_source_dek_on_primary } from '@/services/replication/dek-rehydration-validator';
import { rehydrate_manifests } from '@/services/replication/rehydration-manifests-runner';

const CONFIG = { encryption_passphrase: 'p' } as unknown as AtlasConfig;

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

describe('whole-scope rehydration', () => {
  let primary: ReturnType<typeof make_primary>;
  let tenant_factory: TenantContextFactory;
  let target_factory: () => StorageTarget;

  beforeEach(() => {
    vi.mocked(ensure_source_dek_on_primary).mockClear();
    vi.mocked(rehydrate_manifests).mockClear();
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
