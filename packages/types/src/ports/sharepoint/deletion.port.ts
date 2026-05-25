import type { DeletionResult } from '@/ports/deletion/use-case.port';

export interface SharePointDeletionUseCase {
  /** Deletes all backed-up data for a SharePoint site. */
  delete_site_data(tenant_id: string, site_id: string): Promise<DeletionResult>;

  /** Deletes a specific SharePoint snapshot and its associated blobs. */
  delete_snapshot(tenant_id: string, site_id: string, snapshot_id: string): Promise<DeletionResult>;
}
