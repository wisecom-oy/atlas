import { describe, expect, it } from 'vitest';
import type { HeldOwnerLease } from '@wisecom/atlas-types';
import { OwnerLeaseLostError } from '@wisecom/atlas-types';
import { in_memory_versioned_storage } from '@wisecom/atlas-types/testing/in-memory-versioned-storage';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { DEK_KEY, rewrite_wrapper } from '@/services/keys/dek-wrapper-rewrite';
import { NEW_PASSPHRASE, OLD_PASSPHRASE, OTHER_PASSPHRASE } from './key-set-rig';

/**
 * A run whose lease lapsed between its write and its read-back can find a wrapper that a newer
 * run, now holding the lease, wrote under a third passphrase. That wrapper opens with neither of
 * the stale run's passphrases, and rolling it back would undo a finished rotation (PR #770).
 */

const TENANT = 'tenant-a';

/** A lease that is held for the first `held_checks` checks and lost after that. */
function lease_lost_after(held_checks: number): HeldOwnerLease {
  let checks = 0;
  return {
    assert_held: () => {
      checks += 1;
      if (checks > held_checks) {
        throw new OwnerLeaseLostError({ workload: 'tenant', owner_id: TENANT }, 'it expired');
      }
    },
  } as unknown as HeldOwnerLease;
}

describe('rewrite_wrapper when the lease is lost before the rollback', () => {
  it('leaves the newer run wrapper in place and fails with the lost lease', async () => {
    const bucket = in_memory_versioned_storage();
    const keys = new EnvelopeKeyService(OLD_PASSPHRASE);
    const dek = keys.generate_dek();
    await bucket.storage.put(DEK_KEY, await keys.wrap_dek(dek, TENANT));
    // The newer run's wrapper, under a passphrase this run does not know, lands on this run's write.
    const newer = await new EnvelopeKeyService(OTHER_PASSPHRASE).wrap_dek(dek, TENANT);
    const put = bucket.storage.put.bind(bucket.storage);
    let first = true;
    bucket.storage.put = async (key, data, ...rest) => {
      await put(key, data, ...rest);
      if (key === DEK_KEY && first) {
        first = false;
        await put(key, newer);
      }
    };

    const run = rewrite_wrapper(bucket.storage, lease_lost_after(1), TENANT, {
      current: new EnvelopeKeyService(OLD_PASSPHRASE),
      next: new EnvelopeKeyService(NEW_PASSPHRASE),
    });

    await expect(run).rejects.toBeInstanceOf(OwnerLeaseLostError);
    expect(await bucket.storage.get(DEK_KEY)).toEqual(newer);
  });
});
