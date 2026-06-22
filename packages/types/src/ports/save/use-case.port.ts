export interface SaveOptions {
  readonly folder_name?: string;
  readonly message_ref?: string;
  readonly start_date?: Date;
  readonly end_date?: Date;
  readonly output_path?: string;
  readonly skip_integrity_check?: boolean;
}

export interface SaveResult {
  readonly snapshot_id: string;
  readonly saved_count: number;
  readonly attachment_count: number;
  readonly error_count: number;
  readonly errors: string[];
  readonly output_path: string;
  readonly total_bytes: number;
  readonly integrity_failures: string[];
}

export interface SaveUseCase {
  /** Saves messages from a single snapshot to a zip archive of EML files. */
  save_snapshot(tenant_id: string, snapshot_id: string, options?: SaveOptions): Promise<SaveResult>;

  /** Saves messages from all snapshots for a mailbox, merged and deduplicated. */
  save_mailbox(tenant_id: string, owner_id: string, options?: SaveOptions): Promise<SaveResult>;
}
