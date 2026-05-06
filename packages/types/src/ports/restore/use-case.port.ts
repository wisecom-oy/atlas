export interface RestoreResult {
  readonly snapshot_id: string;
  readonly restored_count: number;
  readonly attachment_count: number;
  readonly error_count: number;
  readonly errors: string[];
  readonly restore_folder_name: string;
}

export interface RestoreOptions {
  readonly folder_name?: string;
  readonly message_ref?: string;
  readonly target_mailbox?: string;
  readonly start_date?: Date;
  readonly end_date?: Date;
}

export interface RestoreUseCase {
  restore_snapshot(
    tenant_id: string,
    snapshot_id: string,
    options?: RestoreOptions,
  ): Promise<RestoreResult>;
  restore_mailbox(
    tenant_id: string,
    owner_id: string,
    options?: RestoreOptions,
  ): Promise<RestoreResult>;
}
