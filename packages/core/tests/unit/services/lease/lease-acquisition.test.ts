import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerBusyError, type ObjectStorage } from '@wisecom/atlas-types';
import { acquire_lease } from '@/services/lease/lease-acquisition';
import { LEASE_TTL_MS, owner_lease_key } from '@/services/lease/lease-record';
import { foreign_lease, lease_test_bucket } from './lease-storage.fixtures';

const KEY = owner_lease_key('outlook', 'user@example.com');

afterEach(() => {
  vi.useRealTimers();
});

describe('acquire_lease', () => {
  it('creates the lease with a token and a TTL, and release deletes it', async () => {
    const bucket = lease_test_bucket();
    const lease = await acquire_lease(bucket.storage, KEY, 'backup');

    const stored = bucket.json(KEY);
    expect(stored).toMatchObject({ format: 1, operation: 'backup', pid: process.pid });
    expect(typeof stored?.token).toBe('string');
    const ttl = Date.parse(String(stored?.expires_at)) - Date.parse(String(stored?.renewed_at));
    expect(ttl).toBe(LEASE_TTL_MS);

    await lease.release();
    expect(bucket.keys()).toEqual([]);
  });

  it('refuses a live lease with the holder and its expiry, writing nothing', async () => {
    const bucket = lease_test_bucket();
    const expires_at = new Date(Date.now() + 5 * 60_000);
    await bucket.write(KEY, foreign_lease(expires_at, 'restore'));

    const error = await acquire_lease(bucket.storage, KEY, 'backup').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OwnerBusyError);
    const busy = error as OwnerBusyError;
    expect(busy.code).toBe('ATLAS_OWNER_BUSY');
    expect(busy.holder).toMatchObject({ operation: 'restore', host: 'other-host', pid: 4242 });
    expect(busy.message).toContain(expires_at.toISOString());
    expect(busy.message).toContain('restore on other-host');
    expect(bucket.json(KEY)?.token).toBe('someone-else');
  });

  it('takes over a lease whose holder let it expire', async () => {
    const bucket = lease_test_bucket();
    await bucket.write(KEY, foreign_lease(new Date(Date.now() - 1000)));

    const lease = await acquire_lease(bucket.storage, KEY, 'backup');

    expect(bucket.json(KEY)?.token).not.toBe('someone-else');
    await lease.release();
  });

  it('takes over an unreadable lease instead of blocking the owner forever', async () => {
    const bucket = lease_test_bucket();
    await bucket.write(KEY, 'not a lease');

    const lease = await acquire_lease(bucket.storage, KEY, 'backup');

    expect(bucket.json(KEY)?.operation).toBe('backup');
    await lease.release();
  });

  it('reports busy when a simultaneous start wins the conditional create', async () => {
    const bucket = lease_test_bucket();
    const racing: ObjectStorage = {
      ...bucket.storage,
      get_with_etag: bucket.storage.get_with_etag.bind(bucket.storage),
      put: async (...args: Parameters<ObjectStorage['put']>) => {
        // The other run's create lands between this run's read and its create.
        await bucket.write(KEY, foreign_lease(new Date(Date.now() + 60_000)));
        return bucket.storage.put(...args);
      },
    } as ObjectStorage;

    const error = await acquire_lease(racing, KEY, 'backup').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OwnerBusyError);
    expect((error as OwnerBusyError).holder?.host).toBe('other-host');
  });

  it('reports busy on a backend that ignores conditions when the read back is not ours', async () => {
    const bucket = lease_test_bucket();
    bucket.faults.ignore_conditions = true;
    const last_writer_wins: ObjectStorage = {
      ...bucket.storage,
      get_with_etag: bucket.storage.get_with_etag.bind(bucket.storage),
      put: async (...args: Parameters<ObjectStorage['put']>) => {
        await bucket.storage.put(...args);
        await bucket.write(KEY, foreign_lease(new Date(Date.now() + 60_000)));
      },
    } as ObjectStorage;

    const error = await acquire_lease(last_writer_wins, KEY, 'backup').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OwnerBusyError);
  });

  it('keys each owner separately and keeps an id with a slash in one segment', () => {
    expect(owner_lease_key('onedrive', 'a/b')).toBe('_meta/leases/onedrive/a%2Fb.json');
    expect(owner_lease_key('outlook', 'x')).not.toBe(owner_lease_key('calendar', 'x'));
  });
});
