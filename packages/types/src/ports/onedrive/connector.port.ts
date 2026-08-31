import type { DriveFileSystemInfo, DriveItemIdentity } from '@/domain/drive-item-metadata';
export interface OneDriveDrive {
  readonly drive_id: string;
  readonly drive_name: string;
}

export type OneDriveDeltaItemKind = 'file' | 'folder';

export interface OneDriveDeltaItem {
  readonly item_id: string;
  readonly drive_id: string;
  readonly kind: OneDriveDeltaItemKind;
  readonly file_name: string;
  readonly parent_path: string;
  readonly web_url?: string;
  /** Graph package facet type (e.g. `oneNote`) when this item is a package root. */
  readonly package_type?: string | undefined;
  readonly size_bytes: number;
  readonly etag?: string;
  readonly last_modified_at?: string;
  /** Client-side timestamps from the `fileSystemInfo` facet, writable on restore. */
  readonly file_system_info?: DriveFileSystemInfo;
  readonly created_by?: DriveItemIdentity;
  readonly last_modified_by?: DriveItemIdentity;
  readonly deleted: boolean;
  /**
   * Graph reports a non-null `malware` facet for this item, so the service will
   * not serve its content. Requires `malware` in the delta `$select`.
   */
  readonly quarantined?: boolean;
  readonly download_url?: string;
}

export interface OneDriveDeltaResult {
  readonly drive_id: string;
  readonly delta_link: string;
  readonly items: OneDriveDeltaItem[];
  readonly reset_detected: boolean;
}

export interface OneDriveFileVersion {
  readonly version_id: string;
  readonly last_modified_at: string;
  readonly size_bytes: number;
  /** Graph `driveItemVersion.lastModifiedBy`: who produced this version. */
  readonly last_modified_by?: DriveItemIdentity;
}

export interface OneDriveConnector {
  /** Lists all OneDrive drives for a user. */
  list_drives(tenant_id: string, owner_id: string): Promise<OneDriveDrive[]>;

  /** Fetches delta changes since the last sync. */
  fetch_delta(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    prev_delta_link?: string,
  ): Promise<OneDriveDeltaResult>;

  /**
   * Fetches one item by id, for retrying a previously failed item that delta
   * will not re-present. Resolves undefined when the item no longer exists.
   */
  fetch_item_by_id(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    item_id: string,
  ): Promise<OneDriveDeltaItem | undefined>;

  /** Downloads full file content for small files. */
  download_file_content(item: OneDriveDeltaItem): Promise<Buffer>;

  /** Resolves the temporary download URL for chunked download. */
  resolve_download_url(item: OneDriveDeltaItem): Promise<string | undefined>;

  /** Lists version history for a file. */
  list_file_versions(drive_id: string, item_id: string): Promise<OneDriveFileVersion[]>;

  /** Downloads a specific historical version of a file. */
  download_file_version(drive_id: string, item_id: string, version_id: string): Promise<Buffer>;

  /**
   * Opens a specific historical version as a stream, for versions too large to
   * hold in memory. Callers below the streaming threshold use
   * {@link download_file_version} instead.
   */
  stream_file_version(
    drive_id: string,
    item_id: string,
    version_id: string,
    size_bytes?: number,
  ): Promise<AsyncIterable<Buffer>>;

  /** Creates a folder in the user's drive. Returns the folder's item ID. */
  create_folder(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    folder_name: string,
  ): Promise<string>;

  /**
   * Uploads a small file (< 4MB) to OneDrive.
   *
   * `file_system_info` carries the timestamps the file had before it was
   * backed up. Without it the service stamps the restore time, which destroys
   * "when was this created" for every restored file.
   */
  upload_small_file(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: Buffer,
    conflict_behavior?: string,
    file_system_info?: DriveFileSystemInfo,
  ): Promise<void>;

  /** Uploads a large file via resumable upload session. */
  upload_large_file(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: Buffer,
    conflict_behavior?: string,
    file_system_info?: DriveFileSystemInfo,
  ): Promise<void>;
}
