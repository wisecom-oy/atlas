import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerLeaseLostError, type OwnerLeaseScope } from '@wisecom/atlas-types';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';
import {
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
  owner_lease_key,
} from '@/services/lease/lease-record';
import { foreign_lease, lease_test_bucket } from './lease-storage.fixtures';

const SCOPE: OwnerLeaseScope = { workload: 'onedrive', owner_id: 'owner-1', operation: 'backup' };
const KEY = owner_lease_key('onedrive', 'owner-1');

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-06-01T00:00:00Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Starts a run that holds the lease until `finish` is called; `ctx` is the leased context. */
function hold_lease(bucket: ReturnType<typeof lease_test_bucket>) {
  let finish!: () => void;
  let leased_storage: typeof bucket.storage | undefined;
  const done = new StorageOwnerLeases().run_exclusive({ storage: bucket.storage }, SCOPE, (ctx) => {
    leased_storage = ctx.storage;
    return new Promise<void>((resolve) => (finish = resolve));
  });
  return {
    done,
    finish: () => finish(),
    storage: () => leased_storage!,
  };
}

describe('lease renewal', () => {
  it('renews every two minutes, so a long run keeps its lease past the TTL', async () => {
    const bucket = lease_test_bucket();
    const run = hold_lease(bucket);
    await vi.advanceTimersByTimeAsync(0);
    const first_expiry = Date.parse(String(bucket.json(KEY)?.expires_at));

    await vi.advanceTimersByTimeAsync(LEASE_TTL_MS + LEASE_RENEW_INTERVAL_MS);

    expect(Date.parse(String(bucket.json(KEY)?.expires_at))).toBeGreaterThan(first_expiry);
    await run.storage().put('state.json', Buffer.from('{}'));
    run.finish();
    await run.done;
  });

  it('keeps the lease through a transient outage that ends before the expiry', async () => {
    const bucket = lease_test_bucket();
    const run = hold_lease(bucket);
    await vi.advanceTimersByTimeAsync(0);

    bucket.faults.unavailable = true;
    await vi.advanceTimersByTimeAsync(3 * LEASE_RENEW_INTERVAL_MS);
    bucket.faults.unavailable = false;
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);

    await run.storage().put('state.json', Buffer.from('{}'));
    run.finish();
    await expect(run.done).resolves.toBeUndefined();
  });

  it('refuses writes once the expiry passes without a successful renewal', async () => {
    const bucket = lease_test_bucket();
    const run = hold_lease(bucket);
    await vi.advanceTimersByTimeAsync(0);

    bucket.faults.unavailable = true;
    await vi.advanceTimersByTimeAsync(LEASE_TTL_MS);
    bucket.faults.unavailable = false;

    await expect(run.storage().put('cursor.json', Buffer.from('{}'))).rejects.toBeInstanceOf(
      OwnerLeaseLostError,
    );
    expect(bucket.keys()).not.toContain('cursor.json');
    run.finish();
    await expect(run.done).rejects.toBeInstanceOf(OwnerLeaseLostError);
  });

  it('refuses writes and fails the run once another run takes the lease over', async () => {
    const bucket = lease_test_bucket();
    const run = hold_lease(bucket);
    await vi.advanceTimersByTimeAsync(0);

    await bucket.write(KEY, foreign_lease(new Date(Date.now() + LEASE_TTL_MS)));
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);

    await expect(run.storage().delete('checkpoint.json')).rejects.toBeInstanceOf(
      OwnerLeaseLostError,
    );
    run.finish();
    await expect(run.done).rejects.toBeInstanceOf(OwnerLeaseLostError);
    // The other run's lease is left alone.
    expect(bucket.json(KEY)?.token).toBe('someone-else');
  });

  it('stops its renewal timer when the run ends', async () => {
    const bucket = lease_test_bucket();
    const run = hold_lease(bucket);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    run.finish();
    await run.done;

    expect(vi.getTimerCount()).toBe(0);
    expect(bucket.keys()).toEqual([]);
  });

  it('lets reads through after the lease is lost', async () => {
    const bucket = lease_test_bucket();
    await bucket.write('manifest.json', { ok: true });
    const run = hold_lease(bucket);
    await vi.advanceTimersByTimeAsync(0);
    await bucket.write(KEY, foreign_lease(new Date(Date.now() + LEASE_TTL_MS)));
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);

    await expect(run.storage().get('manifest.json')).resolves.toBeInstanceOf(Buffer);
    run.finish();
    await run.done.catch(() => undefined);
  });
});
