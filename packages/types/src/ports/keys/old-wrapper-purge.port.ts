/** What one `purge_old_wrappers` call covers. */
export interface OldWrapperPurgeRequest {
  /** Every tenant whose noncurrent wrapped-key versions to purge. Duplicates are purged once. */
  readonly tenant_ids: readonly string[];
  /**
   * Passphrases an old version may be wrapped under, besides the configured one. A version none
   * of them opens is kept, because nothing proves it holds the current data key.
   */
  readonly previous_passphrases: readonly string[];
}

/**
 * What happened to one noncurrent version of the wrapped key.
 *
 * - `deleted`: it unwrapped to the current data key and was deleted.
 * - `retained`: Object Lock or a bucket policy refused the delete. Governance mode is never
 *   bypassed.
 * - `unverified`: none of the supplied passphrases opens it, so it was kept.
 * - `different_key`: it holds another data key, which may still protect retained data. Kept.
 * - `failed`: reading or deleting it failed for another reason.
 */
export interface OldWrapperVersionOutcome {
  readonly version_id: string;
  readonly status: 'deleted' | 'retained' | 'unverified' | 'different_key' | 'failed';
  readonly detail?: string;
}

/**
 * What happened to one tenant.
 *
 * - `purged`: every noncurrent version was deleted, or there was none.
 * - `versions_left`: at least one noncurrent version is still in the bucket; see `versions`.
 * - `no_key`: the tenant has no bucket or no wrapped key.
 * - `current_unopenable`: the configured passphrase does not open the current wrapper, so nothing
 *   was deleted. Finish the re-wrap and switch the configured passphrase first.
 * - `busy`: another operation holds the tenant or one of its owners. Nothing was deleted.
 * - `failed`: the purge stopped with an error before or while listing versions.
 */
export interface TenantWrapperPurgeOutcome {
  readonly tenant_id: string;
  readonly status: 'purged' | 'versions_left' | 'no_key' | 'current_unopenable' | 'busy' | 'failed';
  readonly versions: readonly OldWrapperVersionOutcome[];
  readonly detail?: string;
}

/** Every tenant's outcome, in request order. */
export interface OldWrapperPurgeReport {
  readonly outcomes: readonly TenantWrapperPurgeOutcome[];
  /** True when no noncurrent wrapped-key version is left in any covered bucket. */
  readonly complete: boolean;
}

/** Deletes noncurrent versions of `_meta/dek.enc` that hold the current data key. */
export interface OldWrapperPurgeUseCase {
  /**
   * Purges each tenant under its tenant lease. Refuses a tenant whose current wrapper the
   * configured passphrase cannot open, and never deletes the current version.
   */
  purge_old_wrappers(request: OldWrapperPurgeRequest): Promise<OldWrapperPurgeReport>;
}
