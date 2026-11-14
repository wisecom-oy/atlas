import type {
  HeldOwnerLease,
  ObjectStorage,
  TenantRewrapOutcome,
  TenantSetRewrapRequest,
} from '@wisecom/atlas-types';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import {
  DEK_KEY,
  rewrite_wrapper,
  wrapper_opens,
  type WrapperKeys,
} from '@/services/keys/dek-wrapper-rewrite';

/** Which of the run's two passphrases opens a stored wrapper. */
export type StoredWrapperState = 'opens_with_next' | 'opens_with_current' | 'unopenable';

/**
 * Classifies a stored wrapper against the run's passphrases.
 *
 * The next passphrase is tried first when it differs, so a wrapper an earlier, partial run
 * already re-wrapped is recognised and left alone: that is what makes a rerun safe. A KDF-only
 * refresh has one passphrase, and every wrapper it opens is re-wrapped.
 */
export async function classify_stored_wrapper(
  stored: Buffer,
  keys: WrapperKeys,
  tenant_id: string,
  passphrase_changed: boolean,
): Promise<StoredWrapperState> {
  if (passphrase_changed && (await wrapper_opens(stored, keys.next, tenant_id))) {
    return 'opens_with_next';
  }
  if (await wrapper_opens(stored, keys.current, tenant_id)) return 'opens_with_current';
  return 'unopenable';
}

/**
 * Re-wraps one tenant's key when it is still under the current passphrase, while the caller
 * holds the tenant lease. Both key services are created and destroyed here, so the passphrase
 * buffers are zeroed on every exit.
 */
export async function rewrap_tenant_wrapper(
  storage: ObjectStorage,
  lease: HeldOwnerLease,
  tenant_id: string,
  request: TenantSetRewrapRequest,
): Promise<TenantRewrapOutcome> {
  const keys: WrapperKeys = {
    current: new EnvelopeKeyService(request.current_passphrase),
    next: new EnvelopeKeyService(request.next_passphrase),
  };
  try {
    if (!(await storage.exists(DEK_KEY))) return { tenant_id, status: 'no_key' };

    const changed = request.current_passphrase !== request.next_passphrase;
    const state = await classify_stored_wrapper(
      await storage.get(DEK_KEY),
      keys,
      tenant_id,
      changed,
    );
    if (state === 'opens_with_next') return { tenant_id, status: 'already_rewrapped' };
    if (state === 'unopenable') return { tenant_id, status: 'unopenable' };

    const rewrite = await rewrite_wrapper(storage, lease, tenant_id, keys);
    return { tenant_id, status: 'rewrapped', ...rewrite };
  } finally {
    keys.current.destroy();
    keys.next.destroy();
  }
}
