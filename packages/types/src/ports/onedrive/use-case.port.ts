import type {
  OneDriveFileVersionRecord,
  OneDriveSnapshotManifest,
} from '../../domain/onedrive-manifest';

export interface OneDriveBackupSummary {
  readonly drives_scanned: number;
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

export interface OneDriveBackupResult {
  readonly owner_id: string;
  readonly snapshot: OneDriveSnapshotManifest | undefined;
  readonly summary: OneDriveBackupSummary;
}

export interface OneDriveBackupOptions {
  readonly force_full?: boolean | undefined;
  readonly owner_email?: string | undefined;
  readonly owner_display_name?: string | undefined;
}

export interface OneDriveCatalogUseCase {
  /** Lists all OneDrive snapshots for an owner. */
  list_onedrive_snapshots(tenant_id: string, owner_id: string): Promise<OneDriveSnapshotManifest[]>;

  /** Lists all version records for a specific file. */
  list_onedrive_file_versions(
    tenant_id: string,
    owner_id: string,
    file_ref: string,
  ): Promise<OneDriveFileVersionRecord[]>;
}

export interface OneDriveBackupUseCase {
  /** Executes an incremental (or full) OneDrive backup for a user. */
  backup_onedrive(
    tenant_id: string,
    owner_id: string,
    options?: OneDriveBackupOptions,
  ): Promise<OneDriveBackupResult>;
}

export interface OneDriveVerificationResult {
  readonly snapshot_id: string;
  readonly total_checked: number;
  readonly passed: number;
  readonly failed_file_ids: string[];
  readonly index_issues: string[];
}

export interface OneDriveVerificationUseCase {
  /** Verifies integrity of a OneDrive snapshot. */
  verify_onedrive_snapshot(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
  ): Promise<OneDriveVerificationResult>;
}
