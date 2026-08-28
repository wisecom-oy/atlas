import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';

export type SharePointRestoreConflictBehavior = 'replace' | 'rename' | 'fail';

export interface SharePointRestoreOptions extends OperationControlOptions {
  readonly snapshot_id: string;
  /** Optional target site ID to restore to (defaults to original site). */
  readonly target_site_id?: string;
  /** Only restore specific files (by file ID or full path). */
  readonly file_filter?: string[];
  readonly conflict_behavior?: SharePointRestoreConflictBehavior;
  /**
   * Folder to restore under, created when missing. Absent means a generated `Restore-{timestamp}`
   * root in each destination library.
   */
  readonly destination?: string;
  /** Restore to the original paths instead of nesting under a restore root. */
  readonly in_place?: boolean;
  /** Renames the restored file. Rejected unless the restore resolves to exactly one file. */
  readonly rename_to?: string;
}

export interface SharePointRestoreResult {
  readonly snapshot_id: string;
  readonly files_restored: number;
  readonly folders_created: number;
  readonly files_skipped: number;
  readonly errors: string[];
  readonly interrupted: boolean;
}

export interface SharePointRestoreUseCase {
  /** Restores files from a SharePoint snapshot back to the site's document libraries. */
  restore_sharepoint(
    tenant_id: string,
    site_id: string,
    options: SharePointRestoreOptions,
  ): Promise<SharePointRestoreResult>;
}
