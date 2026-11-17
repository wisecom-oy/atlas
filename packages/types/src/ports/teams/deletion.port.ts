import type { DeletionResult } from '@/ports/deletion/use-case.port';

export interface TeamsDeletionUseCase {
  /** Deletes all backed-up data for a Teams team. */
  delete_team_data(tenant_id: string, team_id: string): Promise<DeletionResult>;

  /** Deletes a specific Teams snapshot and the blobs only it references. */
  delete_snapshot(tenant_id: string, team_id: string, snapshot_id: string): Promise<DeletionResult>;
}
