export interface SharePointLibraryStatus {
  readonly drive_id: string;
  readonly drive_name: string;
  readonly has_backup: boolean;
  /** File changes the next backup would process. Folders are not counted, as backup skips them. */
  readonly pending_changes: number;
  /** Files of this library in the failed-item ledger, awaiting retry or permanently skipped. */
  readonly failed_items: number;
  readonly is_up_to_date: boolean;
  /** `<ErrorClass>: <message>` when the delta peek failed; the library then reports not up to date. */
  readonly peek_error?: string | undefined;
}

export interface SharePointStatusResult {
  readonly site_id: string;
  readonly last_backup_at: Date | undefined;
  readonly last_snapshot_id: string | undefined;
  readonly total_libraries: number;
  readonly libraries: SharePointLibraryStatus[];
  readonly is_up_to_date: boolean;
  readonly total_pending_changes: number;
  /** Every entry in the failed-item ledger. Any entry means the backup is not up to date. */
  readonly total_failed_items: number;
}

export interface SharePointStatusUseCase {
  /**
   * Peeks at Graph delta state and the failed-item ledger to report whether a SharePoint backup is
   * current. Rejects with `AuthError` when Graph refuses the peek.
   */
  check_sharepoint_status(tenant_id: string, site_id: string): Promise<SharePointStatusResult>;
}
