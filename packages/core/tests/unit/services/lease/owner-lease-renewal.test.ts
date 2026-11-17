/**
 * Issue #623: a held lease is renewed every minute, and a run that can no longer prove it holds the
 * lease must stop before it writes a manifest or a cursor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerBusyError, OwnerLeaseLostError } from '@wisecom/atlas-types';
import {
  OWNER_LEASE_RENEW_INTERVAL_MS,
  OWNER_LEASE_TTL_MS,
  SYSTEM_OWNER_LEASE_RUNTIME,
} from '@/services/lease/owner-lease-timing';
import { logger } from '@/utils/logger';
import {
  lease_harness,
  MINUTE_MS,
  OUTLOOK_BACKUP,
  OUTLOOK_KEY,
  precondition_failed,
  START_MS,
} from './owner-lease-harness';

afterEach(() => {
  vi.restoreAllMocks();
});

function silence_warnings(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
}

describe('renewing an owner lease (issue #623)', () => {
  it('keeps a 5 minute lifetime and a 1 minute renewal', () => {
    expect(OWNER_LEASE_TTL_MS).toBe(5 * MINUTE_MS);
    expect(OWNER_LEASE_RENEW_INTERVAL_MS).toBe(MINUTE_MS);
  });

  it('extends the stored expiry by a full lifetime on every renewal', async () => {
    const harness = lease_harness();
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    harness.advance(MINUTE_MS);
    await harness.tick();

    expect(harness.stored()).toMatchObject({
      holder_id: 'holder-1',
      acquired_at: new Date(START_MS).toISOString(),
      expires_at: new Date(START_MS + 6 * MINUTE_MS).toISOString(),
    });
    // Past the original expiry, and still a minute short of the renewed one.
    harness.advance(4 * MINUTE_MS);
    expect(() => lease.assert_held()).not.toThrow();
  });

  it('renews with a compare-and-swap on the ETag of the lease it just read', async () => {
    const if_matches: (string | undefined)[] = [];
    const harness = lease_harness((inner) => ({
      put: async (key, data, metadata, policy, if_match, if_none_match) => {
        if_matches.push(if_match);
        return inner.put(key, data, metadata, policy, if_match, if_none_match);
      },
    }));
    await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    const { etag } = await harness.bucket.ctx.storage.get_with_etag(OUTLOOK_KEY);

    await harness.tick();

    expect(if_matches).toEqual([undefined, etag]);
  });

  it('loses the lease when the renewal swap is refused, and the commit check then fails', async () => {
    silence_warnings();
    const harness = lease_harness((inner) => ({
      put: async (key, data, metadata, policy, if_match, if_none_match) => {
        // Another run replaces the lease between the renewal's read and its write.
        if (if_match !== undefined) harness.store({ holder_id: 'usurper' });
        return inner.put(key, data, metadata, policy, if_match, if_none_match);
      },
    }));
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    await harness.tick();

    const error = capture(() => lease.assert_held());
    expect(error).toBeInstanceOf(OwnerLeaseLostError);
    expect(error).toBeInstanceOf(OwnerBusyError);
    expect(error).toMatchObject({ code: 'ATLAS_OWNER_BUSY', workload: 'outlook' });
    expect((error as Error).message).toContain('lost its lease on outlook owner owner-1');
    expect(harness.stored()?.holder_id).toBe('usurper');
    expect(harness.active_timers()).toBe(0);
  });

  it('loses the lease when storage shows another holder, as after a takeover', async () => {
    silence_warnings();
    const harness = lease_harness();
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    harness.store({ holder_id: 'usurper' });

    await harness.tick();

    expect(() => lease.assert_held()).toThrow(OwnerLeaseLostError);
    expect(harness.stored()?.holder_id).toBe('usurper');
  });

  it('loses the lease when the object is gone and does not write it again', async () => {
    silence_warnings();
    const harness = lease_harness();
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    harness.bucket.remove(OUTLOOK_KEY);

    await harness.tick();

    expect(() => lease.assert_held()).toThrow(/removed from storage/);
    expect(harness.bucket.keys()).toEqual([]);
  });

  it('keeps the lease through a storage failure and loses it only when it runs out', async () => {
    const warn = silence_warnings();
    let storage_down = false;
    const harness = lease_harness((inner) => ({
      get_with_etag: async (key) => {
        if (storage_down) throw new Error('connection reset');
        return inner.get_with_etag(key);
      },
    }));
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    storage_down = true;

    for (let minute = 1; minute <= 4; minute++) {
      harness.advance(MINUTE_MS);
      await harness.tick();
      expect(() => lease.assert_held()).not.toThrow();
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not renew the lease'));
    expect(harness.active_timers()).toBe(1);

    // Thirty seconds before the unrenewed expiry the commit check already fails.
    harness.advance(MINUTE_MS / 2);
    expect(() => lease.assert_held()).toThrow(/could not be renewed before it expired/);
    expect(harness.active_timers()).toBe(0);
  });

  it('renews again once storage answers, without ever having lost the lease', async () => {
    silence_warnings();
    let storage_down = true;
    const harness = lease_harness((inner) => ({
      put: async (key, data, metadata, policy, if_match, if_none_match) => {
        if (storage_down && if_match !== undefined) throw new Error('503 Slow Down');
        return inner.put(key, data, metadata, policy, if_match, if_none_match);
      },
    }));
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    harness.advance(2 * MINUTE_MS);
    await harness.tick();
    storage_down = false;

    harness.advance(MINUTE_MS);
    await harness.tick();

    expect(harness.stored()?.expires_at).toBe(new Date(START_MS + 8 * MINUTE_MS).toISOString());
    harness.advance(4 * MINUTE_MS);
    expect(() => lease.assert_held()).not.toThrow();
  });

  it('marks the lease lost at the renewal after its expiry passed unrenewed', async () => {
    silence_warnings();
    const harness = lease_harness();
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    harness.advance(5 * MINUTE_MS);
    await harness.tick();

    expect(() => lease.assert_held()).toThrow(/expired before it could be renewed/);
    expect(harness.stored()?.expires_at).toBe(new Date(START_MS + 5 * MINUTE_MS).toISOString());
  });

  it('counts a refused swap as renewed when the stored lease is its own retried write', async () => {
    const harness = lease_harness((inner) => ({
      put: async (key, data, metadata, policy, if_match, if_none_match) => {
        await inner.put(key, data, metadata, policy, if_match, if_none_match);
        // The write landed, its response was lost, and the client's retry was refused.
        if (if_match !== undefined) throw precondition_failed();
      },
    }));
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    harness.advance(MINUTE_MS);
    await harness.tick();

    harness.advance(4 * MINUTE_MS);
    expect(() => lease.assert_held()).not.toThrow();
    expect(harness.active_timers()).toBe(1);
  });

  it('detects at the next renewal that a backend ignoring conditions let a second run in', async () => {
    silence_warnings();
    const harness = lease_harness((inner) => ({
      put: async (key, data) => inner.put(key, data),
    }));
    const first = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    const second = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    await harness.tick();

    expect(() => first.assert_held()).toThrow(OwnerLeaseLostError);
    expect(() => second.assert_held()).not.toThrow();
  });

  it('does not start a second renewal while one is still running', async () => {
    let reads = 0;
    let finish_read: () => void = () => undefined;
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
    await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    await harness.tick();
    await harness.tick();

    expect(reads).toBe(2);
    finish_read();
  });
});

describe('the system lease runtime', () => {
  it('schedules renewals on a timer that does not keep the process alive', () => {
    const set_interval = vi.spyOn(globalThis, 'setInterval');

    const stop = SYSTEM_OWNER_LEASE_RUNTIME.schedule(() => undefined, MINUTE_MS);

    const timer = set_interval.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    stop();
  });

  it('gives each run a different random holder id', () => {
    const first = SYSTEM_OWNER_LEASE_RUNTIME.new_holder_id();

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(SYSTEM_OWNER_LEASE_RUNTIME.new_holder_id()).not.toBe(first);
  });
});

function capture(run: () => void): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}
