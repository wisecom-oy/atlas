import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OneDriveReplicationService } from '@/services/replication/onedrive-replication.service';
import { SharePointReplicationService } from '@/services/replication/sharepoint-replication.service';
import { ReplicationStatus, UnreadableObjectsError } from '@wisecom/atlas-types';
import type { ReplicationResult, StorageTarget, TenantContextFactory } from '@wisecom/atlas-types';
import {
  in_memory_tenant_context,
  type InMemoryTenantContext,
} from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
import type { AtlasConfig } from '@/utils/config';

/**
 * Issue #714 for the drive workloads. A drive manifest holds one run's delta, so `-s` on the
 * newest of three snapshots must bring the two older manifests along, refuse a chain that needs a
 * damaged manifest, and fill in what a recovered primary lacks.
 */
vi.mock('@/services/replication/dek-rehydration-validator', () => ({
  ensure_source_dek_on_primary: vi.fn(async () => undefined),
}));

const CONFIG = { encryption_passphrase: 'p' } as unknown as AtlasConfig;
const SCOPE = 'scope-1';

type DriveService = OneDriveReplicationService | SharePointReplicationService;

interface ChainManifest {
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly total_size_bytes: number;
  readonly entries: { file_id: string; storage_key: string; change_type: string }[];
}

interface Workload {
  readonly name: string;
  readonly prefix: string;
  readonly manifest: (n: number) => ChainManifest;
  readonly replicate: (
    service: DriveService,
    snapshot_id: string,
    target: StorageTarget,
  ) => Promise<ReplicationResult[]>;
  readonly rehydrate: (
    service: DriveService,
    snapshot_id: string,
    source: StorageTarget,
  ) => Promise<ReplicationResult>;
  readonly service: (factory: TenantContextFactory, repo: never) => DriveService;
  readonly listing: 'list_readable_snapshots_by_owner' | 'list_readable_snapshots_by_site';
}

function base_manifest(prefix: string, n: number): ChainManifest {
  return {
    snapshot_id: `${prefix === 'onedrive' ? 'od' : 'sp'}-snap-${n * 1000}-abc`,
    created_at: new Date(n * 1000),
    total_size_bytes: 1,
    entries: [
      {
        file_id: `f-${n}`,
        storage_key: `${prefix}/data/${SCOPE}/blob-${n}`,
        change_type: 'created',
      },
    ],
  };
}

const workloads: Workload[] = [
  {
    name: 'OneDrive',
    prefix: 'onedrive',
    manifest: (n) => ({ ...base_manifest('onedrive', n), owner_id: SCOPE }) as ChainManifest,
    replicate: (s, id, t) => (s as OneDriveReplicationService).replicate_owner('t', SCOPE, id, [t]),
    rehydrate: (s, id, src) =>
      (s as OneDriveReplicationService).rehydrate_owner_snapshot('t', SCOPE, id, src),
    service: (factory, repo) =>
      new OneDriveReplicationService(
        factory,
        repo,
        CONFIG,
        vi.fn(async () => undefined),
        vi.fn() as never,
      ),
    listing: 'list_readable_snapshots_by_owner',
  },
  {
    name: 'SharePoint',
    prefix: 'sharepoint',
    manifest: (n) => ({ ...base_manifest('sharepoint', n), site_id: SCOPE }) as ChainManifest,
    replicate: (s, id, t) =>
      (s as SharePointReplicationService).replicate_site('t', SCOPE, id, [t]),
    rehydrate: (s, id, src) =>
      (s as SharePointReplicationService).rehydrate_site_snapshot('t', SCOPE, id, src),
    service: (factory, repo) =>
      new SharePointReplicationService(
        factory,
        repo,
        CONFIG,
        vi.fn(async () => undefined),
        vi.fn() as never,
      ),
    listing: 'list_readable_snapshots_by_site',
  },
];

describe.each(workloads)('$name -s on a three-snapshot chain', (w) => {
  const chain = [w.manifest(1), w.manifest(2), w.manifest(3)];
  const newest = chain[2]!.snapshot_id;
  const key_of = (m: ChainManifest): string =>
    `${w.prefix}/manifests/${SCOPE}/${m.snapshot_id}.json`;
  let primary: InMemoryTenantContext;
  let replica: InMemoryTenantContext;

  function seed(bucket: InMemoryTenantContext, manifests: readonly ChainManifest[]): void {
    bucket.set_raw('_meta/dek.enc', Buffer.from('wrapped-dek'));
    for (const m of manifests) {
      bucket.set_raw(key_of(m), Buffer.from(m.snapshot_id));
      bucket.set_raw(m.entries[0]!.storage_key, Buffer.from('body'));
    }
  }

  function repository(unreadable_keys: string[] = []): never {
    return {
      find_by_snapshot: vi.fn(async (_ctx: unknown, _scope: string, id: string) =>
        chain.find((m) => m.snapshot_id === id),
      ),
      [w.listing]: vi.fn(async () => ({ manifests: [...chain].reverse(), unreadable_keys })),
      ...drive_chain_reads(w.prefix as 'onedrive' | 'sharepoint'),
    } as never;
  }

  function service_over(bucket: InMemoryTenantContext, repo: never = repository()) {
    const factory = {
      create: vi.fn(async () => bucket.ctx),
      create_readonly: vi.fn(async () => bucket.ctx),
    } as unknown as TenantContextFactory;
    return w.service(factory, repo);
  }

  function target_over(bucket: InMemoryTenantContext): StorageTarget {
    return {
      target_id: 'offsite',
      endpoint: 'http://replica.local',
      create_context: vi.fn(async () => bucket.ctx),
    } as unknown as StorageTarget;
  }

  const manifests_in = (bucket: InMemoryTenantContext): string[] =>
    bucket.keys().filter((key) => key.startsWith(`${w.prefix}/manifests/`));

  beforeEach(() => {
    primary = in_memory_tenant_context('t');
    replica = in_memory_tenant_context('t');
  });

  it('replicates every older manifest of the scope with the named one', async () => {
    seed(primary, chain);

    const results = await w.replicate(service_over(primary), newest, target_over(replica));

    expect(results.map((r) => r.snapshot_id)).toEqual(chain.map((m) => m.snapshot_id));
    expect(results.every((r) => r.status === ReplicationStatus.COMPLETED)).toBe(true);
    expect(manifests_in(replica)).toEqual(chain.map(key_of));
  });

  it('writes no newer manifest after an older one fails to copy', async () => {
    seed(primary, chain);
    primary.remove(chain[0]!.entries[0]!.storage_key);

    const results = await w.replicate(service_over(primary), newest, target_over(replica));

    expect(manifests_in(replica)).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0]?.errors.at(-1)).toContain(chain[1]!.snapshot_id);
    expect(results[0]?.errors.at(-1)).toContain(newest);
  });

  it('refuses a chain that needs a damaged older manifest, before any copy', async () => {
    seed(primary, chain);
    const damaged = `${w.prefix}/manifests/${SCOPE}/${w.prefix === 'onedrive' ? 'od' : 'sp'}-snap-1500-abc.json`;
    const target = target_over(replica);

    await expect(
      w.replicate(service_over(primary, repository([damaged])), newest, target),
    ).rejects.toBeInstanceOf(UnreadableObjectsError);
    expect(target.create_context).not.toHaveBeenCalled();
  });

  it('rehydrates the named snapshot and the older manifests the primary lacks', async () => {
    seed(replica, chain);
    seed(primary, [chain[2]!]);

    const result = await w.rehydrate(service_over(primary), newest, target_over(replica));

    expect(result.status).toBe(ReplicationStatus.COMPLETED);
    expect(result.snapshot_id).toBe(newest);
    expect(manifests_in(primary)).toEqual(chain.map(key_of));
  });

  it('reports a skip when the primary already holds the whole chain', async () => {
    seed(replica, chain);
    seed(primary, chain);

    const result = await w.rehydrate(service_over(primary), newest, target_over(replica));

    expect(result).toMatchObject({ snapshot_id: newest, objects_copied: 0, objects_skipped: 1 });
  });
});
