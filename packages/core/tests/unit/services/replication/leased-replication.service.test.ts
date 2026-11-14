/**
 * Issue #740: Outlook replication and rehydration take the owner lease before any write. These
 * run the real lease over an in-memory bucket that another run holds, and assert that nothing is
 * written, then check the lease is taken and released around a free owner's run.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import type {
  Manifest,
  OneDriveReplicationUseCase,
  SharePointReplicationUseCase,
  StorageTarget,
} from '@wisecom/atlas-types';
import { ConfigError, OwnerBusyError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';
import { ReplicationService } from '@/services/replication/replication.service';
import type { FullSnapshotReplicationService } from '@/services/replication/full-snapshot-replication.service';
import { LeasedReplicationService } from '@/services/replication/leased-replication.service';
import type { AtlasConfig } from '@/utils/config';

vi.mock('@/services/replication/dek-rehydration-validator', () => ({
  ensure_source_dek_on_primary: vi.fn().mockResolvedValue(undefined),
}));

const LEASE_KEY = '_meta/outlook-leases/owner-1.json';
const HELD_BY_ANOTHER_RUN = {
  format_version: 1,
  holder_id: 'another-run',
  operation: 'backup',
  acquired_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
};
const SOURCE = {} as StorageTarget;

interface Harness {
  readonly bucket: ReturnType<typeof in_memory_tenant_context>;
  readonly create_readonly: Mock;
  readonly find_by_snapshot: Mock;
  readonly list_all_manifests: Mock;
  readonly target_factory: Mock;
  readonly tenant_factory: ConstructorParameters<typeof ReplicationService>[0];
  readonly manifests: ConstructorParameters<typeof ReplicationService>[1];
  readonly leases: StorageOwnerLeases;
}

/** A primary bucket, mocked ports the inner service reads through, and a real lease port. */
function harness(): Harness {
  const bucket = in_memory_tenant_context('tenant-1');
  const create_readonly = vi.fn(async () => bucket.ctx);
  const find_by_snapshot = vi.fn(async (): Promise<Manifest | undefined> => undefined);
  const list_all_manifests = vi.fn(async () => []);
  const target_factory = vi.fn(() => ({}) as StorageTarget);
  let holders = 0;
  return {
    bucket,
    create_readonly,
    find_by_snapshot,
    list_all_manifests,
    target_factory,
    tenant_factory: {
      create: vi.fn(async () => bucket.ctx),
      create_readonly,
      create_storage_only: vi.fn(async () => ({
        tenant_id: bucket.ctx.tenant_id,
        storage: bucket.ctx.storage,
      })),
    },
    manifests: { find_by_snapshot, list_all_manifests } as never,
    leases: new StorageOwnerLeases({
      now: () => Date.now(),
      schedule: () => () => undefined,
      new_holder_id: () => `holder-${++holders}`,
    }),
  };
}

/** The real inner service over the harness, which a refusal must never reach. */
function real_inner(h: Harness): ReplicationService {
  return new ReplicationService(
    h.tenant_factory,
    h.manifests,
    {} as AtlasConfig,
    vi.fn(),
    { create_context: vi.fn() } as never,
    {} as OneDriveReplicationUseCase,
    {} as SharePointReplicationUseCase,
    {} as FullSnapshotReplicationService,
  );
}

function leased(h: Harness, inner: ReplicationService): LeasedReplicationService {
  return new LeasedReplicationService(
    inner,
    h.tenant_factory,
    h.manifests,
    h.leases,
    h.target_factory as never,
    {} as AtlasConfig,
  );
}

describe('refusing a replication or rehydration of a busy owner (issue #740)', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
    h.bucket.set_raw(LEASE_KEY, Buffer.from(JSON.stringify(HELD_BY_ANOTHER_RUN)));
  });

  it('refuses replicate_mailbox with OwnerBusyError and writes nothing', async () => {
    const before = await h.bucket.ctx.storage.list('');

    await expect(
      leased(h, real_inner(h)).replicate_mailbox('tenant-1', 'owner-1', [SOURCE]),
    ).rejects.toMatchObject({ code: 'ATLAS_OWNER_BUSY', held_by_operation: 'backup' });

    expect(h.list_all_manifests).not.toHaveBeenCalled();
    expect(await h.bucket.ctx.storage.list('')).toEqual(before);
  });

  it('refuses replicate_snapshot for the owner the snapshot manifest names', async () => {
    h.find_by_snapshot.mockResolvedValue({
      owner_id: 'Owner-1',
      snapshot_id: 'snap-1',
      entries: [],
    } as unknown as Manifest);
    const before = await h.bucket.ctx.storage.list('');

    const attempt = leased(h, real_inner(h)).replicate_snapshot('tenant-1', 'snap-1', [SOURCE]);

    await expect(attempt).rejects.toBeInstanceOf(OwnerBusyError);
    await expect(attempt).rejects.toMatchObject({ owner_id: 'owner-1', workload: 'outlook' });
    expect(h.target_factory).not.toHaveBeenCalled();
    expect(await h.bucket.ctx.storage.list('')).toEqual(before);
  });

  it('refuses rehydrate_mailbox before the rehydration reads or writes its manifests', async () => {
    const before = await h.bucket.ctx.storage.list('');

    await expect(
      leased(h, real_inner(h)).rehydrate_mailbox('tenant-1', 'owner-1', SOURCE),
    ).rejects.toBeInstanceOf(OwnerBusyError);

    expect(h.list_all_manifests).not.toHaveBeenCalled();
    expect(await h.bucket.ctx.storage.list('')).toEqual(before);
  });
});

describe('the owner lease around a replication or rehydration of a free owner (issue #740)', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('holds the lease while the run executes, then releases it', async () => {
    let held_during_run = false;
    const fake_inner = {
      replicate_mailbox: vi.fn(async () => {
        held_during_run = await h.bucket.ctx.storage.exists(LEASE_KEY);
        return [];
      }),
    } as unknown as ReplicationService;

    await leased(h, fake_inner).replicate_mailbox('tenant-1', 'owner-1', [SOURCE]);

    expect(held_during_run).toBe(true);
    expect(await h.bucket.ctx.storage.exists(LEASE_KEY)).toBe(false);
  });

  it('releases the lease when the run fails', async () => {
    const fake_inner = {
      rehydrate_mailbox: vi.fn(async () => {
        throw new Error('storage failed');
      }),
    } as unknown as ReplicationService;

    await expect(
      leased(h, fake_inner).rehydrate_mailbox('tenant-1', 'owner-1', SOURCE),
    ).rejects.toThrow('storage failed');

    expect(await h.bucket.ctx.storage.exists(LEASE_KEY)).toBe(false);
  });

  it('refuses a Teams snapshot before any lookup or lease', async () => {
    await expect(
      leased(h, real_inner(h)).replicate_snapshot('tenant-1', 'teams-snap-1', [SOURCE]),
    ).rejects.toBeInstanceOf(ConfigError);

    expect(h.create_readonly).not.toHaveBeenCalled();
    expect(h.find_by_snapshot).not.toHaveBeenCalled();
  });
});
