/**
 * Issue #715: a mailbox-wide replication or rehydration now copies the mailbox's contacts and
 * calendar snapshots too, so it must hold their leases as well as the Outlook one. A contacts or
 * calendar backup of the same mailbox would otherwise write a manifest mid-copy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageTarget } from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import {
  in_memory_tenant_context,
  type InMemoryTenantContext,
} from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';
import { LeasedReplicationService } from '@/services/replication/leased-replication.service';
import type { ReplicationService } from '@/services/replication/replication.service';
import type { AtlasConfig } from '@/utils/config';

vi.mock('@/services/replication/dek-rehydration-validator', () => ({
  ensure_source_dek_on_primary: vi.fn().mockResolvedValue(undefined),
}));

const LEASE_KEYS = [
  '_meta/outlook-leases/owner-1.json',
  'contacts/_meta/owner-1/lease.json',
  'calendar/_meta/owner-1/lease.json',
];
const SOURCE = {} as StorageTarget;

function held_by_another_run(): Buffer {
  return Buffer.from(
    JSON.stringify({
      format_version: 1,
      holder_id: 'another-run',
      operation: 'backup',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    }),
  );
}

/** The leased service over a primary bucket and a real lease port, around `inner`. */
function leased(bucket: InMemoryTenantContext, inner: Partial<ReplicationService>) {
  let holders = 0;
  return new LeasedReplicationService(
    inner as ReplicationService,
    {
      create_storage_only: vi.fn(async () => ({
        tenant_id: bucket.ctx.tenant_id,
        storage: bucket.ctx.storage,
      })),
    } as never,
    {} as never,
    new StorageOwnerLeases({
      now: () => Date.now(),
      schedule: () => () => undefined,
      new_holder_id: () => `holder-${++holders}`,
    }),
    vi.fn(() => ({}) as StorageTarget) as never,
    {} as AtlasConfig,
  );
}

describe('the leases a mailbox-wide replication or rehydration holds', () => {
  let bucket: InMemoryTenantContext;

  beforeEach(() => {
    bucket = in_memory_tenant_context('tenant-1');
  });

  it('holds the Outlook, contacts and calendar leases while the run executes, then releases them', async () => {
    const held: boolean[] = [];
    const inner = {
      replicate_mailbox: vi.fn(async () => {
        for (const key of LEASE_KEYS) held.push(await bucket.ctx.storage.exists(key));
        return [];
      }),
    };

    await leased(bucket, inner).replicate_mailbox('tenant-1', 'Owner-1', [SOURCE]);

    expect(inner.replicate_mailbox).toHaveBeenCalledWith('tenant-1', 'owner-1', [SOURCE]);
    expect(held).toEqual([true, true, true]);
    for (const key of LEASE_KEYS) expect(await bucket.ctx.storage.exists(key)).toBe(false);
  });

  it.each([
    ['contacts', LEASE_KEYS[1]!],
    ['calendar', LEASE_KEYS[2]!],
  ])(
    'refuses replicate_mailbox while a %s run holds the mailbox, before the copy starts',
    async (workload, key) => {
      bucket.set_raw(key, held_by_another_run());
      const inner = { replicate_mailbox: vi.fn() };

      const attempt = leased(bucket, inner).replicate_mailbox('tenant-1', 'owner-1', [SOURCE]);

      await expect(attempt).rejects.toBeInstanceOf(OwnerBusyError);
      await expect(attempt).rejects.toMatchObject({ workload });
      expect(inner.replicate_mailbox).not.toHaveBeenCalled();
      // The leases taken before the busy one are released again.
      expect(bucket.keys()).toEqual([key]);
    },
  );

  it('refuses rehydrate_mailbox while a calendar run holds the mailbox', async () => {
    bucket.set_raw(LEASE_KEYS[2]!, held_by_another_run());
    const inner = { rehydrate_mailbox: vi.fn() };

    await expect(
      leased(bucket, inner).rehydrate_mailbox('tenant-1', 'owner-1', SOURCE),
    ).rejects.toMatchObject({ code: 'ATLAS_OWNER_BUSY', workload: 'calendar' });

    expect(inner.rehydrate_mailbox).not.toHaveBeenCalled();
    expect(bucket.keys()).toEqual([LEASE_KEYS[2]]);
  });
});
