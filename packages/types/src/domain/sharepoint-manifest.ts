import type { DriveFileSystemInfo, DriveItemIdentity } from '@/domain/drive-item-metadata';
import type { FailedItemLedger } from './failed-item';

export type SharePointChangeType =
  'created' | 'updated' | 'moved' | 'renamed' | 'moved_and_renamed' | 'deleted';

export interface SharePointSnapshotManifest {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string;
  readonly site_url?: string;
  readonly site_display_name?: string;
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly total_files: number;
  readonly total_size_bytes: number;
  readonly entries: SharePointManifestEntry[];
}

export interface SharePointManifestEntry {
  readonly file_id: string;
  readonly drive_id: string;
  readonly library_name?: string;
  readonly file_name: string;
  readonly parent_path: string;
  readonly web_url?: string;
  readonly size_bytes: number;
  readonly storage_key?: string;
  readonly checksum?: string;
  readonly etag?: string;
  readonly last_modified_at?: string;
  /** Client-side timestamps, writable on restore unlike the service-side ones. */
  readonly file_system_info?: DriveFileSystemInfo;
  /** Graph `createdBy`; captured for audit. Restoring authorship needs migration-grade APIs. */
  readonly created_by?: DriveItemIdentity;
  /** Graph `lastModifiedBy`; captured for audit. */
  readonly last_modified_by?: DriveItemIdentity;
  readonly backup_at: string;
  readonly change_type: SharePointChangeType;
}

export interface SharePointFileVersionRecord {
  readonly snapshot_id: string;
  readonly backup_at: string;
  readonly drive_id: string;
  readonly file_name: string;
  readonly parent_path: string;
  /** Microsoft Graph `DriveItemVersion.id` when this row is a historical version. */
  readonly version_id?: string;
  readonly web_url?: string;
  readonly size_bytes: number;
  readonly storage_key?: string;
  readonly checksum?: string;
  readonly etag?: string;
  readonly last_modified_at?: string;
  /** Graph `driveItemVersion.lastModifiedBy`: who produced this version. */
  readonly last_modified_by?: DriveItemIdentity;
  readonly change_type: SharePointChangeType;
}

export interface SharePointFileVersionIndex {
  readonly file_id: string;
  readonly site_id: string;
  readonly versions: SharePointFileVersionRecord[];
}

/** Exact position in one file's historical-version stream. */
export interface SharePointVersionWatermark {
  readonly last_modified_at: string;
  /** Version ids captured at this timestamp; Graph timestamps have only second precision. */
  readonly version_ids: string[];
}

export interface SharePointDeltaCursor {
  readonly site_id: string;
  readonly delta_link_by_drive: Record<string, string>;
  readonly previous_path_by_file_id: Record<string, string>;
  readonly previous_name_by_file_id: Record<string, string>;
  readonly previous_etag_by_file_id: Record<string, string>;
  readonly previous_kind_by_file_id: Record<string, 'file' | 'folder'>;
  /**
   * Exact historical-version position per file. The timestamp skips older
   * versions; `version_ids` distinguishes versions that share Graph's
   * second-precision timestamp. Legacy string values are upgraded on the next
   * change to that file. Absent on older cursors; the next run seeds it once
   * from the index.
   */
  readonly version_watermark_by_file_id?: Record<string, SharePointVersionWatermark | string>;
  /**
   * Items that failed to back up, kept so a later run can retry them: delta
   * will not re-present an unchanged item once the link has advanced past it.
   */
  readonly failed_items?: FailedItemLedger | undefined;
  readonly updated_at: string;
}
