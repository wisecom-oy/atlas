/**
 * Issue #974: with an owner exclusion supplied by a host, or the CLI's in-process one, Atlas asks it
 * for every scope it would lease, writes no lease object, and keeps the lease's contract: a refusal
 * is `OwnerBusyError`, a withdrawn grant stops the run at its next commit point, and release runs
 * once and never throws.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  OwnerBusyError,
  OwnerLeaseLostError,
  type OwnerExclusion,
  type OwnerExclusionResult,
  type OwnerLeaseRequest,
} from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { ExclusionOwnerLeases } from '@/services/lease/exclusion-owner-leases';
import { InProcessOwnerExclusion } from '@/services/lease/in-process-owner-exclusion';
import { run_with_owner_lease_when_writable } from '@/services/lease/run-with-owner-lease';
import { owner_lease_key } from '@/services/lease/owner-lease-key';
import { logger } from '@/utils/logger';

const BACKUP: OwnerLeaseRequest = { workload: 'outlook', owner_id: 'owner-1', operation: 'backup' };

function exclusion_answering(result: OwnerExclusionResult): OwnerExclusion & {
  acquire: ReturnType<typeof vi.fn>;
} {
  return { acquire: vi.fn(async () => result) };
}

describe('ExclusionOwnerLeases (issue #974)', () => {
  it('asks the exclusion for the scope and writes nothing to storage', async () => {
    const memory = in_memory_tenant_context('tenant-1');
    const release = vi.fn(async () => undefined);
    const exclusion = exclusion_answering({ acquired: true, release });

    const lease = await new ExclusionOwnerLeases(exclusion).acquire(memory.ctx, BACKUP);
    lease.assert_held();
    await lease.release();
    await lease.release();

    expect(exclusion.acquire).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      workload: 'outlook',
      ownerId: 'owner-1',
      operation: 'backup',
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(lease.storage_key).toBe(owner_lease_key('outlook', 'owner-1'));
    expect(memory.keys()).toEqual([]);
  });

  it('turns a refusal into OwnerBusyError carrying what the host reported', async () => {
    const exclusion = exclusion_answering({
      acquired: false,
      heldByOperation: 'restore',
      busyUntil: '2026-01-01T00:10:00.000Z',
    });

    const refusal = new ExclusionOwnerLeases(exclusion).acquire(
      in_memory_tenant_context().ctx,
      BACKUP,
    );

    await expect(refusal).rejects.toBeInstanceOf(OwnerBusyError);
    await expect(refusal).rejects.toMatchObject({
      workload: 'outlook',
      owner_id: 'owner-1',
      held_by_operation: 'restore',
      lease_expires_at: '2026-01-01T00:10:00.000Z',
    });
  });

  it('rejects an answer that is neither a grant nor a refusal', async () => {
    const exclusion = exclusion_answering({ acquired: true } as unknown as OwnerExclusionResult);

    await expect(
      new ExclusionOwnerLeases(exclusion).acquire(in_memory_tenant_context().ctx, BACKUP),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('stops at the next commit point once the host withdraws the grant', async () => {
    let held = true;
    const exclusion = exclusion_answering({
      acquired: true,
      release: async () => undefined,
      isHeld: () => held,
    });
    const lease = await new ExclusionOwnerLeases(exclusion).acquire(
      in_memory_tenant_context().ctx,
      BACKUP,
    );

    lease.assert_held();
    held = false;

    expect(() => lease.assert_held()).toThrow(OwnerLeaseLostError);
  });

  it('logs a failed release instead of throwing it', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const exclusion = exclusion_answering({
      acquired: true,
      release: async () => Promise.reject(new Error('lock service down')),
    });
    const lease = await new ExclusionOwnerLeases(exclusion).acquire(
      in_memory_tenant_context().ctx,
      BACKUP,
    );

    await expect(lease.release()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock service down'));
    warn.mockRestore();
  });

  it('runs a restore under the exclusion without writing to storage, then frees the owner', async () => {
    const { ctx } = in_memory_tenant_context('tenant-1');
    const put = vi.spyOn(ctx.storage, 'put');
    const leases = new ExclusionOwnerLeases(new InProcessOwnerExclusion());
    const restore: OwnerLeaseRequest = { ...BACKUP, operation: 'restore' };

    const during = await run_with_owner_lease_when_writable(leases, ctx, restore, () =>
      leases.acquire(ctx, BACKUP).then(
        () => 'granted',
        (err: unknown) => (err instanceof OwnerBusyError ? 'busy' : 'failed'),
      ),
    );
    const after = await leases.acquire(ctx, BACKUP);

    expect(during).toBe('busy');
    expect(after.storage_key).toBe(owner_lease_key('outlook', 'owner-1'));
    expect(put).not.toHaveBeenCalled();
  });
});
