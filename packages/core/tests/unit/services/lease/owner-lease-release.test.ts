/**
 * Issue #623: a run gives its owner back when it ends, deletes only a lease that is still its own,
 * and a failed release never replaces the run's own result or error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerLeaseLostError } from '@wisecom/atlas-types';
import { run_with_owner_lease } from '@/services/lease/run-with-owner-lease';
import { logger } from '@/utils/logger';
import {
  lease_harness,
  MINUTE_MS,
  OUTLOOK_BACKUP,
  OUTLOOK_KEY,
  settle,
} from './owner-lease-harness';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('releasing an owner lease (issue #623)', () => {
  it('deletes its own lease and stops renewing, so the next run starts at once', async () => {
    const harness = lease_harness();
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    await lease.release();

    expect(harness.bucket.keys()).toEqual([]);
    expect(harness.active_timers()).toBe(0);
    await expect(harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP)).resolves.toBeDefined();
  });

  it('leaves the lease of the run that took the owner over', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const harness = lease_harness();
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    harness.store({ holder_id: 'usurper' });

    await lease.release();

    expect(harness.stored()?.holder_id).toBe('usurper');
  });

  it('does not touch storage once its own lease has expired', async () => {
    const reads = vi.fn();
    const harness = lease_harness((inner) => ({
      get_with_etag: async (key) => {
        reads();
        return inner.get_with_etag(key);
      },
    }));
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    reads.mockClear();
    harness.advance(5 * MINUTE_MS);

    await lease.release();

    expect(reads).not.toHaveBeenCalled();
    expect(harness.bucket.keys()).toEqual([OUTLOOK_KEY]);
  });

  it('marks the lease released in place when the delete is refused', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const if_matches: (string | undefined)[] = [];
    const harness = lease_harness((inner) => ({
      // A bucket policy that denies DeleteObject on `_meta/*` to protect the data key.
      delete: async () => {
        throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
      },
      put: async (key, data, metadata, policy, if_match, if_none_match) => {
        if_matches.push(if_match);
        return inner.put(key, data, metadata, policy, if_match, if_none_match);
      },
    }));
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    const { etag } = await harness.bucket.ctx.storage.get_with_etag(OUTLOOK_KEY);
    harness.advance(MINUTE_MS);

    await lease.release();

    const released_at = new Date(harness.now()).toISOString();
    expect(harness.stored()).toMatchObject({
      holder_id: 'holder-1',
      released_at,
      expires_at: released_at,
    });
    // The rewrite is a compare-and-swap on the lease this run just read.
    expect(if_matches).toEqual([undefined, etag]);
    expect(warn).not.toHaveBeenCalled();
    expect(harness.active_timers()).toBe(0);
  });

  it('lets the next run take a released lease at once, without a takeover warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const harness = lease_harness(() => ({
      delete: async () => {
        throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
      },
    }));
    const first = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    await first.release();

    const second = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    expect(harness.stored()).toMatchObject({ holder_id: 'holder-2' });
    expect(harness.stored()?.released_at).toBeUndefined();
    expect(() => second.assert_held()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a released record as free even when its expiry still looks live', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const harness = lease_harness();
    // Written by a host whose clock runs ahead: released, with an expiry in this host's future.
    harness.store({
      holder_id: 'finished-run',
      released_at: new Date(harness.now() + 2 * MINUTE_MS).toISOString(),
      expires_at: new Date(harness.now() + 2 * MINUTE_MS).toISOString(),
    });

    await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    expect(harness.stored()?.holder_id).toBe('holder-1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('still warns when it takes over the lease of a holder that died', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const harness = lease_harness();
    harness.store({ holder_id: 'killed-run' });
    harness.advance(5 * MINUTE_MS);

    await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Taking over the lease a backup left behind'),
    );
  });

  it('logs once and resolves when both the delete and the in-place release fail', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let released = false;
    const harness = lease_harness((inner) => ({
      delete: async () => {
        throw new Error('access denied');
      },
      put: async (key, data, metadata, policy, if_match, if_none_match) => {
        if (released) throw new Error('read-only bucket');
        return inner.put(key, data, metadata, policy, if_match, if_none_match);
      },
    }));
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    released = true;

    await expect(lease.release()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not release the lease'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('access denied'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('read-only bucket'));
    expect(harness.stored()?.released_at).toBeUndefined();
    expect(harness.active_timers()).toBe(0);
  });

  it('waits for a renewal in flight, so the lease is not written back after the delete', async () => {
    let finish_read: () => void = () => undefined;
    let reads = 0;
    // Counts reads of this run's own lease: an acquire also reads the tenant lease (issue #739).
    const harness = lease_harness((inner) => ({
      get_with_etag: async (key) => {
        if (key === OUTLOOK_KEY) reads++;
        if (reads === 2 && key === OUTLOOK_KEY) {
          await new Promise<void>((resolve) => (finish_read = resolve));
        }
        return inner.get_with_etag(key);
      },
    }));
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    await harness.tick();

    const released = lease.release();
    await settle();
    expect(harness.bucket.keys()).toEqual([OUTLOOK_KEY]);
    finish_read();
    await released;

    expect(harness.bucket.keys()).toEqual([]);
  });

  it('fails the commit check after the release', async () => {
    const harness = lease_harness();
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    await lease.release();

    expect(() => lease.assert_held()).toThrow(OwnerLeaseLostError);
  });
});

describe('run_with_owner_lease', () => {
  it('holds the lease while the run executes and releases it after a result', async () => {
    const harness = lease_harness();

    const result = await run_with_owner_lease(
      harness.leases,
      harness.ctx,
      OUTLOOK_BACKUP,
      async (lease) => {
        lease.assert_held();
        return harness.stored()?.holder_id;
      },
    );

    expect(result).toBe('holder-1');
    expect(harness.bucket.keys()).toEqual([]);
  });

  it('releases the lease when the run fails and rethrows the run error', async () => {
    const harness = lease_harness();
    const failure = new Error('graph unavailable');

    const run = run_with_owner_lease(harness.leases, harness.ctx, OUTLOOK_BACKUP, async () => {
      throw failure;
    });

    await expect(run).rejects.toBe(failure);
    expect(harness.bucket.keys()).toEqual([]);
  });

  it('keeps the run error when the release fails too', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let storage_down = false;
    const harness = lease_harness((inner) => ({
      get_with_etag: async (key) => {
        if (storage_down) throw new Error('storage unreachable');
        return inner.get_with_etag(key);
      },
    }));
    const failure = new Error('graph unavailable');

    const run = run_with_owner_lease(harness.leases, harness.ctx, OUTLOOK_BACKUP, async () => {
      storage_down = true;
      throw failure;
    });

    await expect(run).rejects.toBe(failure);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not release the lease'));
  });

  it('never starts the run when the owner is busy', async () => {
    const harness = lease_harness();
    harness.store({ holder_id: 'another-run' });
    const run = vi.fn();

    await expect(
      run_with_owner_lease(harness.leases, harness.ctx, OUTLOOK_BACKUP, run),
    ).rejects.toMatchObject({ code: 'ATLAS_OWNER_BUSY' });

    expect(run).not.toHaveBeenCalled();
    expect(harness.stored()?.holder_id).toBe('another-run');
  });
});
