import type { SharePointSnapshotManifest } from '../../domain/sharepoint-manifest';

export interface SharePointBackupSummary {
  readonly libraries_scanned: number;
  readonly files_changed: number;
  readonly files_stored: number;
  readonly files_deduplicated: number;
  readonly deleted_items: number;
  readonly cursor_updated: boolean;
  readonly snapshot_created: boolean;
  readonly versions_stored: number;
  readonly versions_unavailable: number;
  readonly errors: string[];
  readonly warnings: string[];
  readonly healthy: boolean;
}

export interface SharePointBackupResult {
  readonly site_id: string;
  readonly snapshot: SharePointSnapshotManifest | undefined;
  readonly summary: SharePointBackupSummary;
}

export interface SharePointBackupOptions {
  readonly force_full?: boolean | undefined;
  readonly site_url?: string | undefined;
  readonly site_display_name?: string | undefined;
}

export interface SharePointBackupUseCase {
  /** Executes an incremental (or full) SharePoint backup for a site. */
  backup_site(
    tenant_id: string,
    site_id: string,
    options?: SharePointBackupOptions,
  ): Promise<SharePointBackupResult>;
}

export interface SharePointVerificationResult {
  readonly snapshot_id: string;
  readonly total_checked: number;
  readonly passed: number;
  readonly failed_file_ids: string[];
  readonly index_issues: string[];
}

export interface SharePointVerificationUseCase {
  /** Verifies integrity of a SharePoint snapshot. */
  verify_sharepoint_snapshot(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
  ): Promise<SharePointVerificationResult>;
}
