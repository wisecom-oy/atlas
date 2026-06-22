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
  readonly size_bytes: number;
  readonly etag?: string;
  readonly last_modified_at?: string;
  readonly deleted: boolean;
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

  /** Downloads full file content for small files. */
  download_file_content(item: OneDriveDeltaItem): Promise<Buffer>;

  /** Resolves the temporary download URL for chunked download. */
  resolve_download_url(item: OneDriveDeltaItem): Promise<string | undefined>;

  /** Lists version history for a file. */
  list_file_versions(drive_id: string, item_id: string): Promise<OneDriveFileVersion[]>;

  /** Downloads a specific historical version of a file. */
  download_file_version(drive_id: string, item_id: string, version_id: string): Promise<Buffer>;

  /** Creates a folder in the user's drive. Returns the folder's item ID. */
  create_folder(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    folder_name: string,
  ): Promise<string>;

  /** Uploads a small file (< 4MB) to OneDrive. */
  upload_small_file(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: Buffer,
    conflict_behavior?: string,
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
  ): Promise<void>;
}
