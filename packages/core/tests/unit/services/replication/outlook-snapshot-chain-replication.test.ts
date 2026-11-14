import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplicationService } from '@/services/replication/replication.service';
import { ReplicationStatus, UnreadableObjectsError } from '@wisecom/atlas-types';
import type {
  Manifest,
  ManifestRepository,
  StorageTarget,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  in_memory_tenant_context,
  type InMemoryTenantContext,
} from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { outlook_stub_chain_reads } from '@wisecom/atlas-types/testing/stub-outlook-manifest-chain';
import type { AtlasConfig } from '@/utils/config';

/**
 * Issue #714: `replicate -s` and `rehydrate -s` copied the named manifest alone, but an Outlook
 * snapshot is that manifest folded with every older one of the mailbox. A three-manifest chain
 * replicated by its newest id must arrive whole, or not past the first link that failed.
 */
vi.mock('@/services/replication/dek-rehydration-validator', () => ({
  ensure_source_dek_on_primary: vi.fn(async () => undefined),
}));

const CONFIG = { encryption_passphrase: 'p' } as unknown as AtlasConfig;
const MAILBOX = 'mbx-1';

function manifest(n: number): Manifest {
  return {
    id: `m-${n}`,
    tenant_id: 'tenant-1',
    owner_id: MAILBOX,
    snapshot_id: `snap-${n}`,
    created_at: new Date(n * 1000),
    total_objects: 1,
    total_size_bytes: 1,
    delta_links: {},
    entries: [
      {
        object_id: `msg-${n}`,
        storage_key: `data/${MAILBOX}/obj-${n}`,
        checksum: 'c',
        size_bytes: 1,
      },
    ],
  };
}

const manifest_key = (m: Manifest): string => `manifests/${m.owner_id}/${m.snapshot_id}.json`;
const CHAIN = [manifest(1), manifest(2), manifest(3)];

/** Puts a chain's manifests and objects into a bucket, as a backup run would have left them. */
function seed(bucket: InMemoryTenantContext, chain: readonly Manifest[]): void {
  bucket.set_raw('_meta/dek.enc', Buffer.from('wrapped-dek'));
  for (const m of chain) {
    bucket.set_raw(manifest_key(m), Buffer.from(m.snapshot_id));
    for (const entry of m.entries) bucket.set_raw(entry.storage_key, Buffer.from('body'));
  }
}

function repository(chain: readonly Manifest[]): ManifestRepository {
  return {
    find_by_snapshot: vi.fn(async (_ctx: TenantContext, id: string) =>
      chain.find((m) => m.snapshot_id === id),
    ),
    list_by_owner: vi.fn(async () => [...chain]),
    ...outlook_stub_chain_reads(),
  } as unknown as ManifestRepository;
}

function target_over(bucket: InMemoryTenantContext, target_id: string): StorageTarget {
  return {
    target_id,
    endpoint: 'http://replica.local',
    create_context: vi.fn(async () => bucket.ctx),
  } as unknown as StorageTarget;
}

function service(primary: InMemoryTenantContext, repo: ManifestRepository): ReplicationService {
  const tenant_factory = {
    create: vi.fn(async () => primary.ctx),
    create_readonly: vi.fn(async () => primary.ctx),
  } as unknown as TenantContextFactory;
  return new ReplicationService(
    tenant_factory,
    repo,
    CONFIG,
    vi.fn(async () => undefined),
    vi.fn() as never,
    {} as never,
    {} as never,
  );
}

const manifest_keys = (bucket: InMemoryTenantContext): string[] =>
  bucket.keys().filter((key) => key.startsWith('manifests/'));

describe('replicate -s on an Outlook chain', () => {
  let primary: InMemoryTenantContext;
  let replica: InMemoryTenantContext;

  beforeEach(() => {
    primary = in_memory_tenant_context('tenant-1');
    replica = in_memory_tenant_context('tenant-1');
    seed(primary, CHAIN);
  });

  it('copies every older manifest of the mailbox with the named one', async () => {
    const results = await service(primary, repository(CHAIN)).replicate_snapshot(
      'tenant-1',
      'snap-3',
      [target_over(replica, 'offsite')],
    );

    expect(results.map((r) => r.snapshot_id)).toEqual(['snap-1', 'snap-2', 'snap-3']);
    expect(results.every((r) => r.status === ReplicationStatus.COMPLETED)).toBe(true);
    expect(manifest_keys(replica)).toEqual(CHAIN.map(manifest_key));
    expect(replica.keys()).toEqual(
      expect.arrayContaining(CHAIN.map((m) => m.entries[0]!.storage_key)),
    );
    expect(primary.keys().filter((k) => k.startsWith('_meta/replication/'))).toHaveLength(3);
  });

  it('reports a skip and writes nothing when the target already holds the whole chain', async () => {
    seed(replica, CHAIN);
    const before = replica.keys().map((key) => replica.raw(key));

    const results = await service(primary, repository(CHAIN)).replicate_snapshot(
      'tenant-1',
      'snap-3',
      [target_over(replica, 'offsite')],
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      snapshot_id: 'snap-3',
      objects_copied: 0,
      objects_skipped: 1,
    });
    expect(replica.keys().map((key) => replica.raw(key))).toEqual(before);
  });

  it('stops at a link whose objects fail and names the snapshots it left out', async () => {
    primary.remove(CHAIN[1]!.entries[0]!.storage_key);

    const results = await service(primary, repository(CHAIN)).replicate_snapshot(
      'tenant-1',
      'snap-3',
      [target_over(replica, 'offsite')],
    );

    expect(manifest_keys(replica)).toEqual([manifest_key(CHAIN[0]!)]);
    const failed = results.find((r) => r.snapshot_id === 'snap-2');
    expect(failed?.status).toBe(ReplicationStatus.FAILED);
    expect(failed?.errors.at(-1)).toContain('snap-3');
    expect(results.map((r) => r.snapshot_id)).not.toContain('snap-3');
  });

  it('refuses a chain that may need a damaged manifest, before touching the target', async () => {
    const repo = repository(CHAIN);
    vi.mocked(repo.list_by_owner).mockRejectedValue(
      new UnreadableObjectsError('damaged', ['manifests/mbx-1/snap-x.json']),
    );
    const target = target_over(replica, 'offsite');

    await expect(
      service(primary, repo).replicate_snapshot('tenant-1', 'snap-3', [target]),
    ).rejects.toBeInstanceOf(UnreadableObjectsError);
    expect(target.create_context).not.toHaveBeenCalled();
    expect(replica.keys()).toEqual([]);
  });
});

describe('replicate -m on an Outlook mailbox', () => {
  let primary: InMemoryTenantContext;
  let replica: InMemoryTenantContext;

  beforeEach(() => {
    primary = in_memory_tenant_context('tenant-1');
    replica = in_memory_tenant_context('tenant-1');
    seed(primary, CHAIN);
  });

  it('copies only the snapshots the target lacks', async () => {
    seed(replica, [CHAIN[0]!]);

    const results = await service(primary, repository(CHAIN)).replicate_mailbox(
      'tenant-1',
      MAILBOX,
      [target_over(replica, 'offsite')],
    );

    expect(results.map((r) => r.snapshot_id)).toEqual(['snap-2', 'snap-3']);
    expect(manifest_keys(replica)).toEqual(CHAIN.map(manifest_key));
  });

  it('writes no newer snapshot after an older one fails, which it used to', async () => {
    primary.remove(CHAIN[0]!.entries[0]!.storage_key);

    const results = await service(primary, repository(CHAIN)).replicate_mailbox(
      'tenant-1',
      MAILBOX,
      [target_over(replica, 'offsite')],
    );

    expect(manifest_keys(replica)).toEqual([]);
    expect(results.map((r) => r.snapshot_id)).toEqual(['snap-1']);
    expect(results[0]?.errors.at(-1)).toContain('snap-2, snap-3');
  });
});

describe('rehydrate -s on an Outlook chain', () => {
  let primary: InMemoryTenantContext;
  let replica: InMemoryTenantContext;

  beforeEach(() => {
    primary = in_memory_tenant_context('tenant-1');
    replica = in_memory_tenant_context('tenant-1');
    seed(replica, CHAIN);
  });

  it('recovers the named snapshot with every older manifest into an empty primary', async () => {
    const result = await service(primary, repository(CHAIN)).rehydrate_snapshot(
      'tenant-1',
      'snap-3',
      target_over(replica, 'offsite'),
    );

    expect(result.status).toBe(ReplicationStatus.COMPLETED);
    expect(result.snapshot_id).toBe('snap-3');
    expect(result.objects_copied).toBe(3);
    expect(manifest_keys(primary)).toEqual(CHAIN.map(manifest_key));
  });

  it('fills in an older manifest the primary lacks without rewriting the ones it holds', async () => {
    seed(primary, [CHAIN[1]!, CHAIN[2]!]);
    const held = primary.raw(manifest_key(CHAIN[2]!));

    const result = await service(primary, repository(CHAIN)).rehydrate_snapshot(
      'tenant-1',
      'snap-3',
      target_over(replica, 'offsite'),
    );

    expect(result.objects_copied).toBe(1);
    expect(manifest_keys(primary)).toEqual(CHAIN.map(manifest_key));
    expect(primary.raw(manifest_key(CHAIN[2]!))).toBe(held);
  });

  it('names the replica when it does not hold the snapshot', async () => {
    await expect(
      service(primary, repository(CHAIN)).rehydrate_snapshot(
        'tenant-1',
        'snap-9',
        target_over(replica, 'offsite'),
      ),
    ).rejects.toThrow('No manifest found for snapshot snap-9 on source');
  });
});
