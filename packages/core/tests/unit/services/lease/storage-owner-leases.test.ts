import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerBusyError, OwnerLeaseLostError, type OwnerLeaseScope } from '@wisecom/atlas-types';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';
import { owner_lease_key, TENANT_LEASE_KEY } from '@/services/lease/lease-record';
import { logger } from '@/utils/logger';
import { foreign_lease, lease_test_bucket } from './lease-storage.fixtures';

const ALICE: OwnerLeaseScope = { workload: 'outlook', owner_id: 'alice', operation: 'backup' };
const BOB: OwnerLeaseScope = { workload: 'outlook', owner_id: 'bob', operation: 'backup' };

afterEach(() => {
  vi.useRealTimers();
});

describe('StorageOwnerLeases.run_exclusive', () => {
  it('runs different owners of one tenant at the same time', async () => {
    const bucket = lease_test_bucket();
    const leases = new StorageOwnerLeases();
    const ctx = { storage: bucket.storage };
    let release_alice!: () => void;
    const alice_holds = new Promise<void>((resolve) => (release_alice = resolve));

    const alice = leases.run_exclusive(ctx, ALICE, () => alice_holds.then(() => 'alice'));
    await vi.waitFor(() => expect(bucket.keys()).toContain(owner_lease_key('outlook', 'alice')));
    const bob = await leases.run_exclusive(ctx, BOB, async () => 'bob');
    release_alice();

    expect([await alice, bob]).toEqual(['alice', 'bob']);
    expect(bucket.keys()).toEqual([]);
  });

  it('refuses a second run on the same owner before it starts', async () => {
    const bucket = lease_test_bucket();
    const leases = new StorageOwnerLeases();
    const ctx = { storage: bucket.storage };
    let release_first!: () => void;
    const first = leases.run_exclusive(
      ctx,
      ALICE,
      () => new Promise<void>((resolve) => (release_first = resolve)),
    );
    await vi.waitFor(() => expect(bucket.keys()).toHaveLength(1));

    const second_run = vi.fn();
    const error = await leases.run_exclusive(ctx, ALICE, second_run).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OwnerBusyError);
    expect(second_run).not.toHaveBeenCalled();
    release_first();
    await first;
  });

  it('refuses an owner run while purge holds the tenant lease, and leaves no lease behind', async () => {
    const bucket = lease_test_bucket();
    await bucket.write(TENANT_LEASE_KEY, foreign_lease(new Date(Date.now() + 60_000), 'purge'));

    const error = await new StorageOwnerLeases()
      .run_exclusive({ storage: bucket.storage }, ALICE, vi.fn())
      .catch((err: unknown) => err);

    expect((error as OwnerBusyError).lease_key).toBe(TENANT_LEASE_KEY);
    expect(bucket.keys()).toEqual([TENANT_LEASE_KEY]);
  });

  it('refuses purge while an owner lease is live, and releases its own', async () => {
    const bucket = lease_test_bucket();
    const alice_key = owner_lease_key('outlook', 'alice');
    await bucket.write(alice_key, foreign_lease(new Date(Date.now() + 60_000)));

    const error = await new StorageOwnerLeases()
      .run_tenant_exclusive({ storage: bucket.storage }, 'purge', vi.fn())
      .catch((err: unknown) => err);

    expect((error as OwnerBusyError).lease_key).toBe(alice_key);
    expect(bucket.keys()).toEqual([alice_key]);
  });

  it('lets purge run past a crashed owner lease that has expired', async () => {
    const bucket = lease_test_bucket();
    await bucket.write(owner_lease_key('teams', 't1'), foreign_lease(new Date(Date.now() - 1)));

    const result = await new StorageOwnerLeases().run_tenant_exclusive(
      { storage: bucket.storage },
      'purge',
      async () => 'purged',
    );

    expect(result).toBe('purged');
  });

  it('releases the lease when the run throws', async () => {
    const bucket = lease_test_bucket();
    const failing = new StorageOwnerLeases().run_exclusive({ storage: bucket.storage }, ALICE, () =>
      Promise.reject(new Error('boom')),
    );

    await expect(failing).rejects.toThrow('boom');
    expect(bucket.keys()).toEqual([]);
  });
});

describe('StorageOwnerLeases run_exclusive_when_writable', () => {
  it('runs unleased, saying protection is off, when credentials cannot write', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const bucket = lease_test_bucket();
    bucket.faults.deny_writes = true;
    const ctx = { storage: bucket.storage };

    const seen = await new StorageOwnerLeases().run_exclusive_when_writable(
      ctx,
      { ...ALICE, operation: 'restore' },
      async (leased) => leased,
    );

    expect(seen).toBe(ctx);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'concurrent-run protection is off for this restore',
    );
    warn.mockRestore();
  });

  it('still refuses a live lease with read-only credentials', async () => {
    const bucket = lease_test_bucket();
    await bucket.write(
      owner_lease_key('outlook', 'alice'),
      foreign_lease(new Date(Date.now() + 1e5)),
    );
    bucket.faults.deny_writes = true;

    const error = await new StorageOwnerLeases()
      .run_exclusive_when_writable({ storage: bucket.storage }, ALICE, vi.fn())
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OwnerBusyError);
  });

  it('rethrows other storage failures', async () => {
    const bucket = lease_test_bucket();
    bucket.faults.unavailable = true;

    const failing = new StorageOwnerLeases().run_exclusive_when_writable(
      { storage: bucket.storage },
      ALICE,
      vi.fn(),
    );

    await expect(failing).rejects.toThrow('Service Unavailable');
  });
});
