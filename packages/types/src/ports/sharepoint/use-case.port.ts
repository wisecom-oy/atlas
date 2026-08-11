import type {
  SharePointFileVersionRecord,
  SharePointSnapshotManifest,
} from '../../domain/sharepoint-manifest';
import type { ObjectLockRequest } from '../backup/use-case.port';

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
  /**
   * Object Lock retention applied as the bucket's default retention before
   * the run: every new object version (files, versions, manifests, cursors)
   * inherits the lock. Persists on the bucket for subsequent writes.
   */
  readonly object_lock_request?: ObjectLockRequest | undefined;
  /**
   * Back up the site's subsites as well. Each subsite is a Graph site in its
   * own right and gets its own snapshot, so this is a fan-out over the normal
   * per-site pipeline. When false, uncovered subsites are reported as warnings.
   */
  readonly include_subsites?: boolean | undefined;
}

export interface SharePointBackupUseCase {
  /** Executes an incremental (or full) SharePoint backup for a site. */
  backup_site(
    tenant_id: string,
    site_id: string,
    options?: SharePointBackupOptions,
  ): Promise<SharePointBackupResult>;
}

export interface SharePointSiteTreeBackupUseCase {
  /**
   * Backs up a site and, when `include_subsites` is set, every subsite beneath
   * it. Returns one result per backed-up site, root first.
   */
  backup_site_tree(
    tenant_id: string,
    root_site_id: string,
    options?: SharePointBackupOptions,
  ): Promise<SharePointBackupResult[]>;
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

export interface SharePointCatalogUseCase {
  /** Lists all SharePoint snapshots for a site. */
  list_sharepoint_snapshots(
    tenant_id: string,
    site_id: string,
  ): Promise<SharePointSnapshotManifest[]>;

  /** Lists all version records for a specific file. */
  list_sharepoint_file_versions(
    tenant_id: string,
    site_id: string,
    file_ref: string,
  ): Promise<SharePointFileVersionRecord[]>;
}
