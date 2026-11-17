import { inject, injectable } from 'inversify';
import type {
  DekRewrapResult,
  DekRewrapUseCase,
  HeldOwnerLease,
  ObjectStorage,
  OwnerLeasePort,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OWNER_LEASE_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { assert_usable_passphrase } from '@/services/keys/new-passphrase-policy';
import { run_with_owner_lease } from '@/services/lease/run-with-owner-lease';
import { ATLAS_CONFIG_TOKEN, type AtlasConfig } from '@/utils/config';
import { rewrite_wrapper } from '@/services/keys/dek-wrapper-rewrite';

/**
 * Re-wraps a tenant's stored DEK under a new passphrase, new KDF parameters, or both.
 *
 * The DEK itself never changes, so no data object is touched and every existing snapshot stays
 * readable. That also bounds what this is worth: it rotates the wrapper, not the key. Anyone who
 * already holds the DEK or the plaintext is unaffected, and the only answer to that is
 * re-encrypting the bucket (issue #374).
 */
@injectable()
export class DekRewrapService implements DekRewrapUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /**
   * Unwraps with the current passphrase, wraps with the next, then proves the result opens.
   *
   * Runs under the tenant lease, so it is refused with `OwnerBusyError` while any owner of the
   * tenant has a live lease, and an owner operation is refused while it runs (issue #739).
   */
  async rewrap_tenant_dek(tenant_id: string, new_passphrase?: string): Promise<DekRewrapResult> {
    if (new_passphrase !== undefined) assert_usable_passphrase(new_passphrase);

    const ctx = await this._tenant_factory.create_storage_only(tenant_id);
    return run_with_owner_lease(
      this._leases,
      ctx,
      { workload: 'tenant', owner_id: tenant_id, operation: 'rewrap' },
      (lease) => this.rewrap_under_lease(ctx.storage, lease, tenant_id, new_passphrase),
    );
  }

  /** The re-wrap itself, run while the tenant lease is held. */
  private async rewrap_under_lease(
    storage: ObjectStorage,
    lease: HeldOwnerLease,
    tenant_id: string,
    new_passphrase: string | undefined,
  ): Promise<DekRewrapResult> {
    const current = new EnvelopeKeyService(this._config.encryption_passphrase);
    const next = new EnvelopeKeyService(new_passphrase ?? this._config.encryption_passphrase);
    try {
      // A wrong current passphrase fails before anything is written. `unwrap_dek` raises
      // WrongPassphraseError, which already says what to check.
      const rewrite = await rewrite_wrapper(storage, lease, tenant_id, { current, next });
      return { tenant_id, ...rewrite, passphrase_changed: new_passphrase !== undefined };
    } finally {
      current.destroy();
      next.destroy();
    }
  }
}
