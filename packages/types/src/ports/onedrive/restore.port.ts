import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';

export type OneDriveRestoreConflictBehavior = 'replace' | 'rename' | 'fail';

export interface OneDriveRestoreOptions extends OperationControlOptions {
  readonly snapshot_id: string;
  readonly target_owner_id?: string;
  readonly file_filter?: string[];
  readonly conflict_behavior?: OneDriveRestoreConflictBehavior;
  /**
   * Folder to restore under, created when missing. Absent means a generated `Restore-{timestamp}`
   * root at the target drive root.
   */
  readonly destination?: string;
  /** Restore to the original paths instead of nesting under a restore root. */
  readonly in_place?: boolean;
  /** Renames the restored file. Rejected unless the restore resolves to exactly one file. */
  readonly rename_to?: string;
}

export interface OneDriveRestoreResult {
  readonly snapshot_id: string;
  readonly files_restored: number;
  readonly folders_created: number;
  readonly files_skipped: number;
  readonly errors: string[];
  readonly interrupted: boolean;
}

export interface OneDriveRestoreUseCase {
  /** Restores files from a OneDrive snapshot to the target user's drive. */
  restore_onedrive(
    tenant_id: string,
    owner_id: string,
    options: OneDriveRestoreOptions,
  ): Promise<OneDriveRestoreResult>;
}
