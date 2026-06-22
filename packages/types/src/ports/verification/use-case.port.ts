export interface VerificationResult {
  readonly snapshot_id: string;
  readonly total_checked: number;
  readonly passed: number;
  readonly failed: string[];
}

export interface VerificationUseCase {
  verify_snapshot_integrity(tenant_id: string, snapshot_id: string): Promise<VerificationResult>;
}
