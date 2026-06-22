export interface OneDriveDriveStatus {
  readonly drive_id: string;
  readonly drive_name: string;
  readonly has_backup: boolean;
  readonly pending_changes: number;
  readonly is_up_to_date: boolean;
}

export interface OneDriveStatusResult {
  readonly owner_id: string;
  readonly last_backup_at: Date | undefined;
  readonly last_snapshot_id: string | undefined;
  readonly total_drives: number;
  readonly drives: OneDriveDriveStatus[];
  readonly is_up_to_date: boolean;
  readonly total_pending_changes: number;
}

export interface OneDriveStatusUseCase {
  /** Peeks at Graph delta state to report whether a OneDrive backup is current. */
  check_onedrive_status(tenant_id: string, owner_id: string): Promise<OneDriveStatusResult>;
}
