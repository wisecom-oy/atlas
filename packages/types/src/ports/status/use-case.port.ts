import type { OperationCost } from '@/domain/graph/cost';

export interface FolderStatus {
  readonly folder_id: string;
  readonly folder_name: string;
  readonly has_backup: boolean;
  readonly pending_new: number;
  readonly pending_removed: number;
  /**
   * True when the peek stopped at its page cap before the end of the delta, so `pending_new` and
   * `pending_removed` are a lower bound rather than an exact count.
   */
  readonly pending_capped: boolean;
  readonly is_up_to_date: boolean;
  /** `<ErrorClass>: <message>` when the delta peek failed; the folder then reports not up to date. */
  readonly peek_error?: string | undefined;
}

export interface MailboxStatusResult {
  readonly owner_id: string;
  readonly last_backup_at: Date | undefined;
  readonly last_snapshot_id: string | undefined;
  readonly total_folders: number;
  readonly folders: FolderStatus[];
  readonly is_up_to_date: boolean;
  readonly total_pending_changes: number;
  /** True when any folder's count is a lower bound, so `total_pending_changes` is one too. */
  readonly pending_capped: boolean;
  /**
   * Snapshot manifests that could not be read, by storage key. `last_snapshot_id` is then the
   * newest readable snapshot. Present only when a manifest was skipped (issue #631).
   */
  readonly unreadable_keys?: string[] | undefined;
  /** Graph API cost for this operation. Present when called via the SDK; absent via CLI. */
  readonly graph_cost?: OperationCost;
}

export interface StatusUseCase {
  /**
   * Peeks at Graph delta state to report whether a mailbox backup is current. Rejects with
   * `AuthError` or `MailboxNotLicensedError` when Graph refuses the peek.
   */
  check_mailbox_status(tenant_id: string, owner_id: string): Promise<MailboxStatusResult>;
}
