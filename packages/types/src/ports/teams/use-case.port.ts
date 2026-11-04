import type { OperationCost } from '@/domain/graph-cost';
import type {
  TeamsGraphResource,
  TeamsSnapshotIndex,
  TeamsThreadListing,
} from '@/domain/teams-manifest';
import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';
import type { TeamsSnapshotListing } from '@/ports/teams/index-repository.port';
import type { NoSnapshotReason, ObjectLockRequest } from '@/ports/backup/use-case.port';
import type { VerificationOptions } from '@/ports/verification/use-case.port';

export interface TeamsBackupSummary {
  readonly channels_scanned: number;
  readonly channels_full_read: number;
  readonly threads_changed: number;
  readonly threads_stored: number;
  readonly threads_deduplicated: number;
  readonly threads_deleted: number;
  readonly hosted_content_stored: number;
  readonly cursor_updated: boolean;
  readonly snapshot_created: boolean;
  /**
   * Set only when a cleanly completed run created no snapshot, saying which reason it was.
   * Absent when a snapshot was created, and on an interrupted or unhealthy run.
   */
  readonly no_snapshot_reason?: NoSnapshotReason | undefined;
  readonly errors: string[];
  readonly warnings: string[];
  readonly healthy: boolean;
}

export interface TeamsBackupResult {
  readonly team_id: string;
  readonly graph_cost?: OperationCost | undefined;
  readonly snapshot: TeamsSnapshotIndex | undefined;
  readonly interrupted: boolean;
  readonly summary: TeamsBackupSummary;
}

export interface TeamsBackupOptions extends OperationControlOptions {
  readonly force_full?: boolean | undefined;
  readonly team_display_name?: string | undefined;
  /** Back up only this channel. Other channels carry forward from the previous manifest. */
  readonly channel_id?: string | undefined;
  /**
   * Object Lock retention applied as the bucket's default retention before the run. Persists on
   * the bucket for subsequent writes.
   */
  readonly object_lock_request?: ObjectLockRequest | undefined;
}

export interface TeamsBackupUseCase {
  /** Executes an incremental (or full) backup of a team's channel messages. */
  backup_team(
    tenant_id: string,
    team_id: string,
    options?: TeamsBackupOptions,
  ): Promise<TeamsBackupResult>;
}

export interface TeamsVerificationResult {
  readonly snapshot_id: string;
  readonly total_checked: number;
  readonly passed: number;
  /** Objects that exist but fail their checksum or cannot be decrypted. */
  readonly failed_storage_keys: string[];
  /** Objects the snapshot references that are absent from storage. */
  readonly missing_storage_keys: string[];
  readonly interrupted: boolean;
}

export interface TeamsVerificationUseCase {
  /** Verifies integrity of every blob a Teams snapshot references. */
  verify_teams_snapshot(
    tenant_id: string,
    team_id: string,
    snapshot_id: string,
    options?: VerificationOptions,
  ): Promise<TeamsVerificationResult>;
}

export interface TeamsCatalogUseCase {
  /** Lists the teams in the tenant as Graph reports them. */
  list_teams(tenant_id: string): Promise<TeamsGraphResource[]>;

  /** Lists all backed-up snapshots for a team. */
  list_teams_snapshots(tenant_id: string, team_id: string): Promise<TeamsSnapshotListing>;

  /** Lists every thread recorded in one snapshot, across channels. */
  list_snapshot_threads(
    tenant_id: string,
    team_id: string,
    snapshot_id: string,
  ): Promise<TeamsThreadListing[]>;
}
