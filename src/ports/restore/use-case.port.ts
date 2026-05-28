import type { OperationCost } from '@/domain/graph-cost';

export interface RestoreResult {
  readonly snapshot_id: string;
  readonly restored_count: number;
  readonly attachment_count: number;
  readonly error_count: number;
  readonly attachment_error_count: number;
  readonly verification_failures: number;
  readonly errors: string[];
  readonly attachment_errors: string[];
  readonly verification_warnings: string[];
  readonly restore_folder_name: string;
  /**
   * Graph API cost for this operation. Populated when called through the SDK;
   * absent when called through the CLI (no AsyncLocalStorage counter active).
   */
  readonly graph_cost?: OperationCost;
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
    mailbox_id: string,
    options?: RestoreOptions,
  ): Promise<RestoreResult>;
}
