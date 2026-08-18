import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';

export interface VerificationOptions extends OperationControlOptions {
  /**
   * Existence-only verification: batched HeadObject on every referenced key
   * instead of download + decrypt + hash. Catches deleted/missing objects at
   * near-zero bandwidth; use full mode for scheduled deep verification.
   */
  readonly fast?: boolean;
}

export interface VerificationResult {
  readonly snapshot_id: string;
  readonly total_checked: number;
  readonly passed: number;
  readonly failed: string[];
  readonly interrupted: boolean;
  /**
   * Objects that can never be verified because no blob was stored for them
   * (e.g. attachments skipped by pre-fix backups with an empty storage_key).
   * These count against restorability but are reported separately from
   * corruption.
   */
  readonly unverifiable: string[];
  /** Number of delta manifests in the merged chain this verification covered. */
  readonly manifests_in_chain: number;
}

export interface VerificationUseCase {
  /**
   * Verifies the full restorable state of a snapshot: resolves the merged
   * entry set across the snapshot's manifest chain (the same view restore
   * uses) and checks every referenced object -- message blobs and
   * attachments.
   */
  verify_snapshot_integrity(
    tenant_id: string,
    snapshot_id: string,
    options?: VerificationOptions,
  ): Promise<VerificationResult>;
}
