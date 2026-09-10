export interface DekRewrapResult {
  readonly tenant_id: string;
  /** KDF the wrapper used before this run. */
  readonly previous_kdf_id: number;
  /** KDF the new wrapper uses; equal to the previous one when only the passphrase changed. */
  readonly kdf_id: number;
  readonly passphrase_changed: boolean;
}

export interface DekRewrapUseCase {
  /**
   * Re-wraps the tenant's stored data key under `new_passphrase`, or under the configured one
   * with current KDF parameters when it is omitted.
   *
   * The data key itself is unchanged, so no stored object is re-encrypted and every existing
   * snapshot stays readable. This rotates the wrapper, not the key.
   */
  rewrap_tenant_dek(tenant_id: string, new_passphrase?: string): Promise<DekRewrapResult>;
}
