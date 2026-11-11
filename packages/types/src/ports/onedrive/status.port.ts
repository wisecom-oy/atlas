export interface OneDriveDriveStatus {
  readonly drive_id: string;
  readonly drive_name: string;
  readonly has_backup: boolean;
  /** File changes the next backup would process. Folders are not counted, as backup skips them. */
  readonly pending_changes: number;
  /** Files of this drive in the failed-item ledger, awaiting retry or permanently skipped. */
  readonly failed_items: number;
  readonly is_up_to_date: boolean;
  /** `<ErrorClass>: <message>` when the delta peek failed; the drive then reports not up to date. */
  readonly peek_error?: string | undefined;
}

export interface OneDriveStatusResult {
  readonly owner_id: string;
  readonly last_backup_at: Date | undefined;
  readonly last_snapshot_id: string | undefined;
  readonly total_drives: number;
  readonly drives: OneDriveDriveStatus[];
  readonly is_up_to_date: boolean;
  readonly total_pending_changes: number;
  /** Every entry in the failed-item ledger. Any entry means the backup is not up to date. */
  readonly total_failed_items: number;
  /**
   * Snapshot manifests that could not be read, by storage key. `last_snapshot_id` is then the
   * newest readable snapshot. Present only when a manifest was skipped (issue #631).
   */
  readonly unreadable_keys?: string[] | undefined;
}

export interface OneDriveStatusUseCase {
  /**
   * Peeks at Graph delta state and the failed-item ledger to report whether a OneDrive backup is
   * current. Rejects with `AuthError` when Graph refuses the peek.
   */
  check_onedrive_status(tenant_id: string, owner_id: string): Promise<OneDriveStatusResult>;
}
