export interface FolderStatus {
  readonly folder_id: string;
  readonly folder_name: string;
  readonly has_backup: boolean;
  readonly pending_new: number;
  readonly pending_removed: number;
  readonly is_up_to_date: boolean;
}

export interface MailboxStatusResult {
  readonly owner_id: string;
  readonly last_backup_at: Date | undefined;
  readonly last_snapshot_id: string | undefined;
  readonly total_folders: number;
  readonly folders: FolderStatus[];
  readonly is_up_to_date: boolean;
  readonly total_pending_changes: number;
}

export interface StatusUseCase {
  /** Peeks at Graph delta state to report whether a mailbox backup is current. */
  check_mailbox_status(tenant_id: string, owner_id: string): Promise<MailboxStatusResult>;
}
