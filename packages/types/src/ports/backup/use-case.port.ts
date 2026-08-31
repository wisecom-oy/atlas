import type { Manifest } from '@/domain/manifest';
import type { Snapshot } from '@/domain/snapshot';
import type { OperationCost } from '@/domain/graph-cost';
import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';
import type { ExcludedFolder } from '@/ports/mail/connector.port';

export type BackupSyncMode = 'full' | 'incremental' | 'initial';
export type ObjectLockMode = 'GOVERNANCE' | 'COMPLIANCE';

/**
 * Requested Object Lock protection for the objects a run writes. Any policy carrying
 * `retain_until` is enforced fail-closed by the storage adapter: a bucket without
 * versioning or Object Lock, or one that cannot honour the mode, rejects the write
 * rather than storing unprotected data.
 */
export interface ObjectLockPolicy {
  readonly mode?: ObjectLockMode | undefined;
  readonly retain_until?: string | undefined;
}

export interface ObjectLockRequest {
  readonly mode?: ObjectLockMode | undefined;
  readonly retention_days?: number | undefined;
}

export interface BackupProgressReporter {
  set_status(message: string): void;
  mark_active(index: number): void;
  update_active(index: number, processed: number, rate: number, eta_seconds: number): void;
  update_paging(index: number, items_fetched: number, rate: number, eta_seconds: number): void;
  /** Sets a row's item total once known (e.g. after a delta fetch reveals the count). */
  set_row_total?(index: number, total_items: number): void;
  mark_done(index: number, stored: number, deduped: number, attachments: number): void;
  /** Marks a row up to date without counters (e.g. an incremental delta with no changes). */
  mark_synced?(index: number): void;
  mark_all_pending_interrupted(): void;
  mark_error(index: number, message: string): void;
  update_total(
    global_processed: number,
    global_total: number,
    rate: number,
    eta_seconds: number,
  ): void;
  finish(actual_total?: number): void;
}

export interface SyncOptions extends OperationControlOptions {
  readonly folder_filter?: string[] | undefined;
  readonly force_full?: boolean | undefined;
  readonly page_size?: number | undefined;
  readonly object_lock_policy?: ObjectLockPolicy | undefined;
  readonly object_lock_request?: ObjectLockRequest | undefined;
  readonly progress?: BackupProgressReporter | undefined;
  readonly create_progress?:
    ((folders: { name: string; total_items: number }[]) => BackupProgressReporter) | undefined;
  readonly should_force_stop?: (() => boolean) | undefined;
  readonly owner_email?: string | undefined;
  readonly owner_display_name?: string | undefined;
  /**
   * Skip Junk Email. Junk is captured by default: it is evidence during a
   * phishing or BEC investigation, and a backup that drops it cannot answer
   * whether a message ever arrived.
   */
  readonly exclude_junk?: boolean | undefined;
  /**
   * Also back up the Exchange Recoverable Items subtree: hard-deleted mail and
   * items retained only by a litigation hold or retention policy. Off by
   * default because on a mailbox under hold it can rival the mailbox in size.
   */
  readonly include_recoverable_items?: boolean | undefined;
}

export interface BackupSyncSummary {
  readonly stored: number;
  readonly deduplicated: number;
  readonly attachments_stored: number;
  readonly processed: number;
  readonly folder_errors: string[];
  readonly warnings: string[];
  readonly interrupted: boolean;
  readonly completed_folder_count: number;
  readonly total_folder_count: number;
  readonly elapsed_ms: number;
  /** Folders this run did not capture, with why. */
  readonly excluded_folders: ExcludedFolder[];
}

export interface SyncResult {
  readonly snapshot: Snapshot;
  readonly manifest: Manifest;
  readonly mode: BackupSyncMode;
  readonly summary: BackupSyncSummary;
  readonly interrupted: boolean;
  /** Graph API cost for this operation. Present when called via the SDK; absent via CLI. */
  readonly graph_cost?: OperationCost;
}

export interface BackupUseCase {
  /** Runs a full or incremental backup; `owner_id` is the mailbox owner's Entra object ID (storage partition). */
  sync_mailbox(tenant_id: string, owner_id: string, options?: SyncOptions): Promise<SyncResult>;
}
