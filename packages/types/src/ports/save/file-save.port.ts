export interface FileSaveOptions {
  readonly snapshot_id: string;
  /** Only save specific files (by file ID or full path). */
  readonly file_filter?: string[];
  /** Output zip file path (default: auto-generated). */
  readonly output_path?: string;
  /** Skip SHA-256 integrity checks. */
  readonly skip_integrity_check?: boolean;
}

export interface FileSaveResult {
  readonly snapshot_id: string;
  readonly files_saved: number;
  readonly files_skipped: number;
  readonly errors: string[];
  readonly integrity_failures: string[];
  readonly output_path: string;
  readonly total_bytes: number;
}

export interface OneDriveSaveUseCase {
  /** Saves files from a OneDrive snapshot to a local zip archive. */
  save_snapshot(
    tenant_id: string,
    owner_id: string,
    options: FileSaveOptions,
  ): Promise<FileSaveResult>;
}

export interface SharePointSaveUseCase {
  /** Saves files from a SharePoint snapshot to a local zip archive. */
  save_snapshot(
    tenant_id: string,
    site_id: string,
    options: FileSaveOptions,
  ): Promise<FileSaveResult>;
}
