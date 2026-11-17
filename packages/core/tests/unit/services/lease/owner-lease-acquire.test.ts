/**
 * Issue #623: nothing stopped two operations on one mailbox, drive owner, site or team from
 * overwriting each other's cursor. These cover taking the per-owner lease: a free owner, a busy
 * one, and a lease left behind by a run that died.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { OwnerBusyError, StorageError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import { owner_lease_key } from '@/services/lease/owner-lease-key';
import { ObjectLockingStorage } from '@/services/shared/run-object-lock';
import {
  lease_harness,
  MINUTE_MS,
  OUTLOOK_BACKUP,
  OUTLOOK_KEY,
  START_MS,
} from './owner-lease-harness';

describe('acquiring an owner lease (issue #623)', () => {
  it('writes a lease for a free owner that names the run, the operation and a 5 minute expiry', async () => {
    const harness = lease_harness();

    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    expect(lease.storage_key).toBe('_meta/outlook-leases/owner-1.json');
    expect(harness.stored()).toEqual({
      format_version: 1,
      holder_id: 'holder-1',
      operation: 'backup',
      acquired_at: new Date(START_MS).toISOString(),
      expires_at: new Date(START_MS + 5 * MINUTE_MS).toISOString(),
    });
    expect(() => lease.assert_held()).not.toThrow();
  });

  it('creates the lease create-only and without an Object Lock policy', async () => {
    const put = vi.fn();
    const harness = lease_harness((inner) => ({
      put: async (...args) => {
        put(...args.slice(2));
        return inner.put(...args);
      },
    }));

    await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    // metadata, object_lock_policy, if_match, if_none_match
    expect(put).toHaveBeenCalledExactlyOnceWith(undefined, undefined, undefined, true);
  });

  it('refuses a context decorated with run retention, which would lock the lease', async () => {
    const harness = lease_harness();
    const retained = {
      ...harness.ctx,
      storage: new ObjectLockingStorage(harness.ctx.storage, { mode: 'GOVERNANCE' }),
    } as TenantContext;

    await expect(harness.leases.acquire(retained, OUTLOOK_BACKUP)).rejects.toThrow(
      /without run retention/,
    );
    expect(harness.bucket.keys()).toEqual([]);
  });

  it('fails a second acquire while the lease is live, naming the operation and the expiry', async () => {
    const harness = lease_harness();
    await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    harness.advance(4 * MINUTE_MS);

    const second = harness.leases.acquire(harness.ctx, { ...OUTLOOK_BACKUP, operation: 'delete' });

    const error = await second.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OwnerBusyError);
    expect(error).toMatchObject({
      code: 'ATLAS_OWNER_BUSY',
      workload: 'outlook',
      owner_id: 'owner-1',
      held_by_operation: 'backup',
      lease_expires_at: new Date(START_MS + 5 * MINUTE_MS).toISOString(),
    });
    expect((error as Error).message).toContain('Another backup is running on outlook owner');
    expect((error as Error).message).toContain(new Date(START_MS + 5 * MINUTE_MS).toISOString());
    expect(harness.stored()?.holder_id).toBe('holder-1');
  });

  it('takes over a lease whose expiry has passed', async () => {
    const harness = lease_harness();
    harness.store({ holder_id: 'killed-run' });
    harness.advance(5 * MINUTE_MS);

    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    expect(harness.stored()?.holder_id).toBe('holder-1');
    expect(() => lease.assert_held()).not.toThrow();
  });

  it('takes over a lease object that is not JSON', async () => {
    const harness = lease_harness();
    harness.bucket.set_raw(OUTLOOK_KEY, Buffer.from('not a lease'));

    await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    expect(harness.stored()?.holder_id).toBe('holder-1');
  });

  it('takes over a lease whose body is not a lease record', async () => {
    const harness = lease_harness();
    harness.store({ expires_at: 'not a date' });

    await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    expect(harness.stored()?.holder_id).toBe('holder-1');
  });

  it('never takes over a lease in a newer format, even when it looks expired', async () => {
    const harness = lease_harness();
    harness.store({ format_version: 2, holder_id: 'newer-atlas' });
    harness.advance(60 * MINUTE_MS);

    await expect(harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP)).rejects.toBeInstanceOf(
      UnsupportedFormatVersionError,
    );
    expect(harness.stored()?.holder_id).toBe('newer-atlas');
  });

  it('stores the lease as plain JSON and takes it through a storage-only context', async () => {
    const harness = lease_harness();
    const storage_only = { tenant_id: 'tenant-test', storage: harness.ctx.storage };

    await harness.leases.acquire(storage_only, OUTLOOK_BACKUP);

    const body = harness.bucket.raw(OUTLOOK_KEY)?.toString('utf-8') ?? '';
    expect(JSON.parse(body)).toMatchObject({ holder_id: 'holder-1', operation: 'backup' });
    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual([
      'acquired_at',
      'expires_at',
      'format_version',
      'holder_id',
      'operation',
    ]);
  });

  it('loses the takeover race when another run replaces the dead lease first', async () => {
    const harness = lease_harness((inner) => ({
      put: async (key, data, metadata, policy, if_match, if_none_match) => {
        // The competitor swaps its lease in between this run's read and its compare-and-swap.
        if (if_match !== undefined) harness.store({ holder_id: 'faster-run', operation: 'delete' });
        return inner.put(key, data, metadata, policy, if_match, if_none_match);
      },
    }));
    harness.store({ holder_id: 'killed-run' });
    harness.advance(5 * MINUTE_MS);

    const error = await harness.leases
      .acquire(harness.ctx, OUTLOOK_BACKUP)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OwnerBusyError);
    expect(error).toMatchObject({ held_by_operation: 'delete' });
    expect(harness.stored()?.holder_id).toBe('faster-run');
  });

  it('fails when the lease read back is another run, as on a backend that ignores conditions', async () => {
    const harness = lease_harness((inner) => ({
      put: async (key, data) => {
        // Both creates are accepted, and the other run's lands last.
        await inner.put(key, data);
        harness.store({ holder_id: 'other-run' });
      },
    }));

    await expect(harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP)).rejects.toBeInstanceOf(
      OwnerBusyError,
    );
    expect(harness.active_timers()).toBe(0);
  });

  it('fails with a storage error when the lease it wrote is not there to read back', async () => {
    const harness = lease_harness(() => ({ put: async () => undefined }));

    await expect(harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP)).rejects.toBeInstanceOf(
      StorageError,
    );
  });

  it('holds the lease when a retried create is refused by its own first attempt', async () => {
    const harness = lease_harness((inner) => ({
      put: async (...args) => {
        await inner.put(...args);
        // The response of the first attempt was lost, so the client retries and is refused.
        if (args[5] === true) await inner.put(...args);
      },
    }));

    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    expect(harness.stored()?.holder_id).toBe('holder-1');
    expect(() => lease.assert_held()).not.toThrow();
  });

  it('lets different owners and different workloads hold leases at the same time', async () => {
    const harness = lease_harness();

    await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    await harness.leases.acquire(harness.ctx, { ...OUTLOOK_BACKUP, owner_id: 'owner-2' });
    await harness.leases.acquire(harness.ctx, { ...OUTLOOK_BACKUP, workload: 'onedrive' });
    await harness.leases.acquire(harness.ctx, { ...OUTLOOK_BACKUP, workload: 'calendar' });

    expect(harness.bucket.keys()).toEqual([
      '_meta/outlook-leases/owner-1.json',
      '_meta/outlook-leases/owner-2.json',
      'calendar/_meta/owner-1/lease.json',
      'onedrive/_meta/owner-1/lease.json',
    ]);
  });
});

describe('owner_lease_key', () => {
  it.each([
    ['outlook', '_meta/outlook-leases/owner-1.json'],
    ['onedrive', 'onedrive/_meta/owner-1/lease.json'],
    ['sharepoint', 'sharepoint/_meta/owner-1/lease.json'],
    ['contacts', 'contacts/_meta/owner-1/lease.json'],
    ['calendar', 'calendar/_meta/owner-1/lease.json'],
    ['teams', 'teams/_meta/owner-1/lease.json'],
  ] as const)('puts the %s lease next to the owner cursor', (workload, key) => {
    expect(owner_lease_key(workload, 'owner-1')).toBe(key);
  });

  it.each(['', '.', '..', 'a/b', 'a\\b'])('rejects the owner id %j', (owner_id) => {
    expect(() => owner_lease_key('onedrive', owner_id)).toThrow(/storage key segment/);
  });
});
