import type { DeletionResult } from '@/ports/deletion/use-case.port';

export interface OneDriveDeletionUseCase {
  /** Deletes all backed-up data for a OneDrive owner. */
  delete_owner_data(tenant_id: string, owner_id: string): Promise<DeletionResult>;

  /** Deletes a specific OneDrive snapshot and its associated blobs. */
  delete_snapshot(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult>;
}
