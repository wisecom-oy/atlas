/**
 * Issue #740: replication and rehydration hold the owner lease, so they exclude a backup of the
 * same owner in either direction and never exclude work on another owner. These run the real
 * lease over an in-memory bucket.
 */
import { describe, expect, it } from 'vitest';
import type { OwnerLeaseRequest, TenantStorageContext } from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';

const START_MS = Date.parse('2026-03-01T10:00:00.000Z');

function request(
  operation: OwnerLeaseRequest['operation'],
  owner_id = 'owner-1',
): OwnerLeaseRequest {
  return { workload: 'outlook', owner_id, operation };
}

function leases_over(): StorageOwnerLeases {
  let holders = 0;
  return new StorageOwnerLeases({
    now: () => START_MS,
    schedule: () => () => undefined,
    new_holder_id: () => `holder-${++holders}`,
  });
}

function storage_only(): TenantStorageContext {
  return { storage: in_memory_tenant_context().ctx.storage } as TenantStorageContext;
}

describe('replication and rehydration take the owner lease (issue #740)', () => {
  it.each(['replicate', 'rehydrate'] as const)(
    'refuses a backup of an owner while a %s holds it, naming the holder',
    async (operation) => {
      const ctx = storage_only();
      const leases = leases_over();
      const held = await leases.acquire(ctx, request(operation));

      const attempt = leases.acquire(ctx, request('backup'));

      await expect(attempt).rejects.toBeInstanceOf(OwnerBusyError);
      await expect(attempt).rejects.toMatchObject({
        code: 'ATLAS_OWNER_BUSY',
        held_by_operation: operation,
      });
      await held.release();
    },
  );

  it.each(['replicate', 'rehydrate'] as const)(
    'refuses a %s while a backup of the owner holds it',
    async (operation) => {
      const ctx = storage_only();
      const leases = leases_over();
      const held = await leases.acquire(ctx, request('backup'));

      await expect(leases.acquire(ctx, request(operation))).rejects.toMatchObject({
        code: 'ATLAS_OWNER_BUSY',
        held_by_operation: 'backup',
      });
      await held.release();
    },
  );

  it('refuses a rehydration while a replication of the same owner holds it', async () => {
    const ctx = storage_only();
    const leases = leases_over();
    const held = await leases.acquire(ctx, request('replicate'));

    await expect(leases.acquire(ctx, request('rehydrate'))).rejects.toMatchObject({
      held_by_operation: 'replicate',
    });
    await held.release();
  });

  it('lets a replication and a rehydration of different owners proceed together', async () => {
    const ctx = storage_only();
    const leases = leases_over();

    const replicating = await leases.acquire(ctx, request('replicate', 'owner-1'));
    const rehydrating = await leases.acquire(ctx, request('rehydrate', 'owner-2'));

    expect(replicating.storage_key).not.toBe(rehydrating.storage_key);
    await replicating.release();
    await rehydrating.release();
  });

  it('frees the owner for a backup once the replication releases its lease', async () => {
    const ctx = storage_only();
    const leases = leases_over();
    const held = await leases.acquire(ctx, request('replicate'));
    await held.release();

    const backup = await leases.acquire(ctx, request('backup'));

    expect(backup.storage_key).toBe(held.storage_key);
    await backup.release();
  });
});
