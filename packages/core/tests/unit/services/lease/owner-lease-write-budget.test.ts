/**
 * Issue #918: every write of a lease leaves one version in a versioned bucket, and some backends
 * refuse writes to a key that holds 1,000 versions. A held lease is read back every minute but
 * written only every five, so a held hour leaves at most 14 versions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerLeaseLostError } from '@wisecom/atlas-types';
import { logger } from '@/utils/logger';
import {
  lease_harness,
  MINUTE_MS,
  OUTLOOK_BACKUP,
  OUTLOOK_KEY,
  RENEW_MS,
} from './owner-lease-harness';

afterEach(() => {
  vi.restoreAllMocks();
});

const HOUR_MS = 60 * MINUTE_MS;

/** A harness that counts the writes (puts and deletes) and reads of the Outlook lease key. */
function counting_harness(): {
  harness: ReturnType<typeof lease_harness>;
  writes: () => number;
  reads: () => number;
} {
  let writes = 0;
  let reads = 0;
  const harness = lease_harness((inner) => ({
    put: async (key, data, metadata, policy, if_match, if_none_match) => {
      if (key === OUTLOOK_KEY) writes++;
      return inner.put(key, data, metadata, policy, if_match, if_none_match);
    },
    delete: async (key) => {
      if (key === OUTLOOK_KEY) writes++;
      return inner.delete(key);
    },
    get_with_etag: async (key) => {
      if (key === OUTLOOK_KEY) reads++;
      return inner.get_with_etag(key);
    },
  }));
  return { harness, writes: () => writes, reads: () => reads };
}

/** Advances the clock a minute at a time, firing the renewal timer after each step. */
async function hold_for(harness: ReturnType<typeof lease_harness>, ms: number): Promise<void> {
  for (let elapsed = MINUTE_MS; elapsed <= ms; elapsed += MINUTE_MS) {
    harness.advance(MINUTE_MS);
    await harness.tick();
  }
}

describe('lease writes per held hour (issue #918)', () => {
  it('reads the lease every minute and rewrites it only once a renewal is due', async () => {
    const { harness, writes, reads } = counting_harness();
    await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    const writes_after_acquire = writes();
    const reads_after_acquire = reads();

    await hold_for(harness, RENEW_MS - MINUTE_MS);
    expect(writes()).toBe(writes_after_acquire);
    expect(reads() - reads_after_acquire).toBe(RENEW_MS / MINUTE_MS - 1);

    await hold_for(harness, MINUTE_MS);
    expect(writes()).toBe(writes_after_acquire + 1);
  });

  it('writes at most 14 versions for a lease held one hour: acquire, 12 renewals, release', async () => {
    const { harness, writes } = counting_harness();
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);

    await hold_for(harness, HOUR_MS);
    await lease.release();

    expect(writes()).toBe(14);
    expect(harness.bucket.keys()).toEqual([]);
  });

  it('still notices a takeover within a minute, between two writes', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { harness, writes } = counting_harness();
    const lease = await harness.leases.acquire(harness.ctx, OUTLOOK_BACKUP);
    const writes_after_acquire = writes();
    harness.advance(MINUTE_MS);
    harness.store({ holder_id: 'usurper' });

    await harness.tick();

    expect(() => lease.assert_held()).toThrow(OwnerLeaseLostError);
    expect(writes()).toBe(writes_after_acquire);
    expect(harness.stored()?.holder_id).toBe('usurper');
  });
});
