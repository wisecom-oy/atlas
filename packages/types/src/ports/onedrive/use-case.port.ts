import type {
  OneDriveFileVersionRecord,
  OneDriveSnapshotManifest,
} from '../../domain/onedrive-manifest';
import type { BackupProgressReporter, ObjectLockRequest } from '../backup/use-case.port';
import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';
import type { VerificationOptions } from '@/ports/verification/use-case.port';
import type {
  DriveVersionRestoreOptions,
  DriveVersionRestoreResult,
} from '@/ports/drive/version-restore.port';

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
  readonly interrupted: boolean;
  readonly summary: OneDriveBackupSummary;
}

export interface OneDriveBackupOptions extends OperationControlOptions {
  readonly force_full?: boolean | undefined;
  readonly owner_email?: string | undefined;
  readonly owner_display_name?: string | undefined;
  /**
   * Restrict the backup to one folder and its descendants, e.g. `/Projects`.
   * Absent backs up the whole drive. Changing the scope between runs forces a
   * full re-crawl, because a delta link is drive-wide and cannot be resumed
   * under a different filter.
   */
  readonly folder_scope?: string | undefined;
  /**
   * Object Lock retention applied as the bucket's default retention before
   * the run: every new object version (files, versions, manifests, cursors)
   * inherits the lock. Persists on the bucket for subsequent writes.
   */
  readonly object_lock_request?: ObjectLockRequest | undefined;
  /**
   * CLI presenter hook: builds a per-drive progress reporter before the scan
   * starts. Drive totals arrive via `set_row_total` once each delta is fetched.
   * When absent the service reports progress nowhere.
   */
  readonly create_progress?:
    ((drives: { name: string; total_items: number }[]) => BackupProgressReporter) | undefined;
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

export interface OneDriveVersionRestoreUseCase {
  /**
   * Restores stored version bytes back into OneDrive.
   *
   * Reads the bytes Atlas holds rather than promoting a version in the
   * service: after a mass encrypt-and-sync the live version history may be
   * trimmed or gone, and only a checksum-verified copy proves the operator
   * gets what the backup recorded.
   */
  restore_onedrive_version(
    tenant_id: string,
    owner_id: string,
    options: DriveVersionRestoreOptions,
  ): Promise<DriveVersionRestoreResult>;
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
  readonly interrupted: boolean;
}

export interface OneDriveVerificationUseCase {
  /** Verifies integrity of a OneDrive snapshot. */
  verify_onedrive_snapshot(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
    options?: VerificationOptions,
  ): Promise<OneDriveVerificationResult>;
}
