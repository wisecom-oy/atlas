import type { Camelize } from '@/public/case-convert';
import type { TenantSetRewrapReport } from '@/ports/keys/tenant-set-rewrap.port';

/** Which tenants a key operation covers, and between which passphrases it re-wraps. */
export interface KeysRewrapOptions {
  /** Every tenant whose key shares the passphrase. Defaults to this instance's tenant. */
  readonly tenantIds?: readonly string[];
  /** The passphrase the stored wrappers open with now. Defaults to the configured one. */
  readonly currentPassphrase?: string;
  /** The passphrase to wrap under. Defaults to the configured one, a KDF-only refresh. */
  readonly newPassphrase?: string;
}

/** Key management across every tenant that shares one passphrase. */
export interface KeysApi {
  /**
   * Re-wraps each tenant still under the current passphrase and reports every tenant. Safe to
   * repeat: a tenant already under the new passphrase is skipped.
   */
  rewrapTenantKeys(options?: KeysRewrapOptions): Promise<Camelize<TenantSetRewrapReport>>;
}
