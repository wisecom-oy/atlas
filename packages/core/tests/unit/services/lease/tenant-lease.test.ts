import { describe, expect, it } from 'vitest';
import type { HeldOwnerLease, OwnerLeaseRequest } from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import { TENANT_LEASE_KEY } from '@/services/lease/owner-lease-key';
import { run_with_owner_lease } from '@/services/lease/run-with-owner-lease';
import {
  lease_harness,
  MINUTE_MS,
  OUTLOOK_BACKUP,
  OUTLOOK_KEY,
  START_MS,
} from './owner-lease-harness';

/** A purge or re-wrap of the tenant; the owner id is the tenant id (issue #739). */
const PURGE: OwnerLeaseRequest = {
  workload: 'tenant',
  owner_id: 'tenant-test',
  operation: 'purge',
};

const PAST = new Date(START_MS - MINUTE_MS).toISOString();

describe('tenant lease', () => {
  it('takes the tenant lease at its own key and deletes it on release', async () => {
    const h = lease_harness();

    const lease = await h.leases.acquire(h.ctx, PURGE);

    expect(lease.storage_key).toBe(TENANT_LEASE_KEY);
    expect(h.stored(TENANT_LEASE_KEY)?.operation).toBe('purge');
    expect(h.stored(OUTLOOK_KEY)).toBeUndefined();
    await lease.release();
    expect(h.stored(TENANT_LEASE_KEY)).toBeUndefined();
  });

  it('refuses an owner backup while a purge holds the tenant, and leaves no owner lease', async () => {
    const h = lease_harness();
    const purge = await h.leases.acquire(h.ctx, PURGE);

    const err = await h.leases.acquire(h.ctx, OUTLOOK_BACKUP).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OwnerBusyError);
    expect(err).toMatchObject({
      workload: 'outlook',
      owner_id: 'owner-1',
      held_by_operation: 'purge',
    });
    expect(h.stored(OUTLOOK_KEY)).toBeUndefined();
    expect(h.stored(TENANT_LEASE_KEY)?.holder_id).toBe('holder-1');
    await purge.release();
  });

  it('refuses a purge while an owner lease is live, and leaves no tenant lease', async () => {
    const h = lease_harness();
    const backup = await h.leases.acquire(h.ctx, OUTLOOK_BACKUP);

    const err = await h.leases.acquire(h.ctx, PURGE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OwnerBusyError);
    expect(err).toMatchObject({
      workload: 'outlook',
      owner_id: 'owner-1',
      held_by_operation: 'backup',
    });
    expect(h.stored(TENANT_LEASE_KEY)).toBeUndefined();
    expect(h.stored(OUTLOOK_KEY)?.holder_id).toBe('holder-1');
    await backup.release();
  });

  it('refuses a second purge while the first holds the tenant lease', async () => {
    const h = lease_harness();
    const first = await h.leases.acquire(h.ctx, PURGE);

    const err = await h.leases.acquire(h.ctx, PURGE).catch((e: unknown) => e);

    expect(err).toMatchObject({
      workload: 'tenant',
      owner_id: 'tenant-test',
      held_by_operation: 'purge',
    });
    await first.release();
  });

  it.each([
    ['expired', { expires_at: PAST }],
    ['released', { released_at: new Date(START_MS).toISOString() }],
  ])('a %s owner lease does not block a purge', async (_state, record) => {
    const h = lease_harness();
    h.store(record, OUTLOOK_KEY);

    const purge = await h.leases.acquire(h.ctx, PURGE);

    expect(h.stored(TENANT_LEASE_KEY)?.operation).toBe('purge');
    await purge.release();
  });

  it('a damaged owner lease does not block a purge', async () => {
    const h = lease_harness();
    h.bucket.set_raw(OUTLOOK_KEY, Buffer.from('not json'));

    const purge = await h.leases.acquire(h.ctx, PURGE);

    await purge.release();
  });

  it('a tenant lease left by a crashed purge expires and stops blocking owners', async () => {
    const h = lease_harness();
    // The purge process was killed: it never releases the lease.
    await h.leases.acquire(h.ctx, PURGE);

    h.advance(6 * MINUTE_MS);
    const backup = await h.leases.acquire(h.ctx, OUTLOOK_BACKUP);

    expect(h.stored(OUTLOOK_KEY)?.holder_id).toBe('holder-2');
    await backup.release();
  });

  it('renews the tenant lease every minute, like an owner lease', async () => {
    const h = lease_harness();
    const lease = await h.leases.acquire(h.ctx, PURGE);
    const first_expiry = Date.parse(h.stored(TENANT_LEASE_KEY)!.expires_at);

    h.advance(MINUTE_MS);
    await h.tick();

    expect(Date.parse(h.stored(TENANT_LEASE_KEY)!.expires_at)).toBeGreaterThan(first_expiry);
    await lease.release();
  });

  it('releases the tenant lease when the run fails', async () => {
    const h = lease_harness();

    await expect(
      run_with_owner_lease(h.leases, h.ctx, PURGE, async () => {
        throw new Error('sweep failed');
      }),
    ).rejects.toThrow('sweep failed');

    expect(h.stored(TENANT_LEASE_KEY)).toBeUndefined();
  });

  it('reads the tenant lease once per owner acquire, whatever the owner holds', async () => {
    let tenant_reads = 0;
    const h = lease_harness((inner) => ({
      get_with_etag: async (key: string) => {
        if (key === TENANT_LEASE_KEY) tenant_reads++;
        return inner.get_with_etag(key);
      },
    }));

    const backup = await h.leases.acquire(h.ctx, OUTLOOK_BACKUP);

    expect(tenant_reads).toBe(1);
    await backup.release();
  });
});

describe('tenant lease against an owner lease written at the same instant', () => {
  it('never lets both sides proceed: the owner side is refused when both wrote before either read', async () => {
    let arrived = 0;
    let open_gate!: () => void;
    const both_written = new Promise<void>((resolve) => {
      open_gate = resolve;
    });
    // Each lease write waits until the other side's write has also started, so both writes land
    // before either side reads the other's lease.
    const h = lease_harness((inner) => ({
      put: async (key, data, metadata, policy, if_match, if_none_match) => {
        if (key === OUTLOOK_KEY || key === TENANT_LEASE_KEY) {
          arrived++;
          if (arrived === 2) open_gate();
          await both_written;
        }
        return inner.put(key, data, metadata, policy, if_match, if_none_match);
      },
    }));

    const [owner, tenant] = await Promise.allSettled([
      h.leases.acquire(h.ctx, OUTLOOK_BACKUP),
      h.leases.acquire(h.ctx, PURGE),
    ]);

    expect(owner.status).toBe('rejected');
    expect((owner as PromiseRejectedResult).reason).toBeInstanceOf(OwnerBusyError);
    for (const side of [owner, tenant]) {
      if (side.status === 'fulfilled') await (side.value as HeldOwnerLease).release();
    }
    expect(h.stored(OUTLOOK_KEY)).toBeUndefined();
    expect(h.stored(TENANT_LEASE_KEY)).toBeUndefined();
  });
});
