/**
 * Issue #623: a restore takes the owner's lease, and with read-only storage credentials runs
 * without one, saying so, unless another run holds a live lease.
 */
import { describe, expect, it, vi } from 'vitest';
import { OwnerBusyError, type ObjectStorage, type OwnerLeaseRequest } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { run_with_owner_lease_when_writable } from '@/services/lease/run-with-owner-lease';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';
import { owner_lease_key } from '@/services/lease/owner-lease-key';
import { logger } from '@/utils/logger';

const RESTORE: OwnerLeaseRequest = {
  workload: 'onedrive',
  owner_id: 'owner-1',
  operation: 'restore',
};
const KEY = owner_lease_key('onedrive', 'owner-1');

/** Storage whose writes are refused with 403, as read-only credentials are. */
function read_only(storage: ObjectStorage): ObjectStorage {
  const denied = Object.assign(new Error('Access Denied'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });
  return new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop === 'put') return () => Promise.reject(denied);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

function stored_lease(expires_at: Date): Buffer {
  return Buffer.from(
    JSON.stringify({
      format_version: 1,
      holder_id: 'another-run',
      operation: 'backup',
      acquired_at: new Date(expires_at.getTime() - 60_000).toISOString(),
      expires_at: expires_at.toISOString(),
    }),
  );
}

describe('run_with_owner_lease_when_writable', () => {
  it('holds the lease while the restore runs and releases it after', async () => {
    const harness = in_memory_tenant_context();
    let held_during_run = false;

    await run_with_owner_lease_when_writable(
      new StorageOwnerLeases(),
      harness.ctx,
      RESTORE,
      async () => {
        held_during_run = harness.keys().includes(KEY);
      },
    );

    expect(held_during_run).toBe(true);
    expect(harness.keys()).not.toContain(KEY);
  });

  it('refuses a restore while another run holds the owner', async () => {
    const harness = in_memory_tenant_context();
    harness.set_raw(KEY, stored_lease(new Date(Date.now() + 60_000)));
    const run = vi.fn();

    const restore = run_with_owner_lease_when_writable(
      new StorageOwnerLeases(),
      harness.ctx,
      RESTORE,
      run,
    );

    await expect(restore).rejects.toBeInstanceOf(OwnerBusyError);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs without a lease and says protection is off when credentials cannot write', async () => {
    const harness = in_memory_tenant_context();
    const ctx = { ...harness.ctx, storage: read_only(harness.ctx.storage) };
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await run_with_owner_lease_when_writable(
      new StorageOwnerLeases(),
      ctx,
      RESTORE,
      async (seen) => seen,
    );

    expect(result).toBe(ctx);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain(
      'concurrent-run protection is off for this restore',
    );
    warn.mockRestore();
  });

  it('still refuses with read-only credentials when another run holds a live lease', async () => {
    const harness = in_memory_tenant_context();
    harness.set_raw(KEY, stored_lease(new Date(Date.now() + 60_000)));
    const ctx = { ...harness.ctx, storage: read_only(harness.ctx.storage) };
    const run = vi.fn();

    const restore = run_with_owner_lease_when_writable(new StorageOwnerLeases(), ctx, RESTORE, run);

    await expect(restore).rejects.toBeInstanceOf(OwnerBusyError);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs with read-only credentials past an expired lease', async () => {
    const harness = in_memory_tenant_context();
    harness.set_raw(KEY, stored_lease(new Date(Date.now() - 1)));
    const ctx = { ...harness.ctx, storage: read_only(harness.ctx.storage) };
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(
      run_with_owner_lease_when_writable(new StorageOwnerLeases(), ctx, RESTORE, async () => 'ok'),
    ).resolves.toBe('ok');
    vi.restoreAllMocks();
  });
});
