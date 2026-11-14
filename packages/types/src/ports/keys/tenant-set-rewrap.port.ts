/** What one `rewrap_tenant_set` call re-wraps, and between which passphrases. */
export interface TenantSetRewrapRequest {
  /** Every tenant whose key shares the passphrase. Duplicates are re-wrapped once. */
  readonly tenant_ids: readonly string[];
  /** The passphrase the stored wrappers open with now. */
  readonly current_passphrase: string;
  /** The passphrase to wrap under. Equal to `current_passphrase` for a KDF-only refresh. */
  readonly next_passphrase: string;
}

/**
 * What happened to one tenant's wrapped key.
 *
 * - `rewrapped`: it opened with the current passphrase and now opens with the next one.
 * - `already_rewrapped`: it already opened with the next passphrase, so nothing was written.
 *   Only reported when the passphrase changes; a KDF-only refresh re-wraps every key.
 * - `no_key`: the tenant has no bucket or no wrapped key, so nothing is wrapped under either.
 * - `unopenable`: neither passphrase opens it. Nothing was written.
 * - `busy`: another operation holds the tenant or one of its owners. Nothing was written.
 * - `failed`: the re-wrap stopped with an error; `detail` says which and what was left.
 */
export type TenantRewrapOutcome =
  | {
      readonly tenant_id: string;
      readonly status: 'rewrapped';
      readonly previous_kdf_id: number;
      readonly kdf_id: number;
    }
  | {
      readonly tenant_id: string;
      readonly status: 'already_rewrapped' | 'no_key' | 'unopenable';
    }
  | { readonly tenant_id: string; readonly status: 'busy' | 'failed'; readonly detail: string };

/** Every tenant's outcome, in request order. */
export interface TenantSetRewrapReport {
  readonly outcomes: readonly TenantRewrapOutcome[];
  readonly passphrase_changed: boolean;
  /**
   * True when no tenant is left under the current passphrase: every outcome is `rewrapped`,
   * `already_rewrapped` or `no_key`. Only then may the current passphrase be retired.
   */
  readonly complete: boolean;
}

/** Re-wraps every tenant key that shares one passphrase, one tenant lease at a time. */
export interface TenantSetRewrapUseCase {
  /**
   * Classifies each tenant's stored wrapper and re-wraps the ones still under the current
   * passphrase. A tenant that fails does not stop the rest, and a rerun after a partial run
   * re-wraps only what is left, so the call is safe to repeat.
   */
  rewrap_tenant_set(request: TenantSetRewrapRequest): Promise<TenantSetRewrapReport>;
}
