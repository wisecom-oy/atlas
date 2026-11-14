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
  /** Damaged manifests outside the snapshot's chain, by key: reported, not needed (issue #631). */
  readonly unreadable_keys?: string[] | undefined;
  /**
   * File filter values that matched no file while other values did. The run is partial, and the
   * CLI exits 2 (issue #707). A filter that matched no file at all rejects with NotFoundError.
   */
  readonly unmatched_file_filters?: string[] | undefined;
}

export interface OneDriveRestoreUseCase {
  /**
   * Restores files from a OneDrive snapshot to the target user's drive.
   *
   * Rejects with WrongPassphraseError when the data key does not unwrap, before anything is
   * written. A stored object that is missing, fails AES-GCM authentication, or mismatches its
   * checksum is one damaged file: it is listed in `errors` and the rest are restored.
   */
  restore_onedrive(
    tenant_id: string,
    owner_id: string,
    options: OneDriveRestoreOptions,
  ): Promise<OneDriveRestoreResult>;
}
