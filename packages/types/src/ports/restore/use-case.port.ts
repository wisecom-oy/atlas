import type { OperationCost } from '@/domain/graph-cost';
import type { TransferProgressReporter } from '@/ports/shared/transfer-progress.port';
import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';

export interface RestoreResult {
  readonly snapshot_id: string;
  readonly restored_count: number;
  readonly attachment_count: number;
  readonly error_count: number;
  readonly attachment_error_count: number;
  readonly errors: string[];
  readonly verification_warnings: string[];
  readonly restore_folder_name: string;
  /** Graph API cost for this operation. Present when called via the SDK; absent via CLI. */
  readonly graph_cost?: OperationCost;
  readonly interrupted: boolean;
}

export interface RestoreOptions extends OperationControlOptions {
  readonly folder_name?: string;
  readonly message_ref?: string;
  readonly target_mailbox?: string;
  readonly start_date?: Date;
  readonly end_date?: Date;
  /** CLI presenter hook; when absent the service reports progress nowhere. */
  readonly create_progress?: (
    folders: { name: string; total_items: number }[],
  ) => TransferProgressReporter;
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
