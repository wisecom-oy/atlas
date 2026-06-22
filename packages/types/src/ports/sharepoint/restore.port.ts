export type SharePointRestoreConflictBehavior = 'replace' | 'rename' | 'fail';

export interface SharePointRestoreOptions {
  readonly snapshot_id: string;
  /** Optional target site ID to restore to (defaults to original site). */
  readonly target_site_id?: string;
  /** Only restore specific files (by file ID or full path). */
  readonly file_filter?: string[];
  readonly conflict_behavior?: SharePointRestoreConflictBehavior;
}

export interface SharePointRestoreResult {
  readonly snapshot_id: string;
  readonly files_restored: number;
  readonly folders_created: number;
  readonly files_skipped: number;
  readonly errors: string[];
}

export interface SharePointRestoreUseCase {
  /** Restores files from a SharePoint snapshot back to the site's document libraries. */
  restore_sharepoint(
    tenant_id: string,
    site_id: string,
    options: SharePointRestoreOptions,
  ): Promise<SharePointRestoreResult>;
}
