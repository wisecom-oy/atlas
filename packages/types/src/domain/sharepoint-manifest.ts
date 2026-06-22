export type SharePointChangeType =
  | 'created'
  | 'updated'
  | 'moved'
  | 'renamed'
  | 'moved_and_renamed'
  | 'deleted';

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
  readonly change_type: SharePointChangeType;
}

export interface SharePointFileVersionIndex {
  readonly file_id: string;
  readonly site_id: string;
  readonly versions: SharePointFileVersionRecord[];
}

export interface SharePointDeltaCursor {
  readonly site_id: string;
  readonly delta_link_by_drive: Record<string, string>;
  readonly previous_path_by_file_id: Record<string, string>;
  readonly previous_name_by_file_id: Record<string, string>;
  readonly previous_etag_by_file_id: Record<string, string>;
  readonly previous_kind_by_file_id: Record<string, 'file' | 'folder'>;
  readonly updated_at: string;
}
