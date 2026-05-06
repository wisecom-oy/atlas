export interface OneDriveRestoreOptions {
  readonly snapshot_id: string;
  readonly target_owner_id?: string;
  readonly file_filter?: string[];
}

export interface OneDriveRestoreResult {
  readonly snapshot_id: string;
  readonly files_restored: number;
  readonly folders_created: number;
  readonly files_skipped: number;
  readonly errors: string[];
}

export interface OneDriveRestoreUseCase {
  /** Restores files from a OneDrive snapshot to the target user's drive. */
  restore_onedrive(
    tenant_id: string,
    owner_id: string,
    options: OneDriveRestoreOptions,
  ): Promise<OneDriveRestoreResult>;
}
