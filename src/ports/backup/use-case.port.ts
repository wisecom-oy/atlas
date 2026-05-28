import type { Manifest } from '@/domain/manifest';
import type { Snapshot } from '@/domain/snapshot';

export type BackupSyncMode = 'full' | 'incremental' | 'initial';
export type ObjectLockMode = 'GOVERNANCE' | 'COMPLIANCE';

export interface ObjectLockPolicy {
  readonly mode?: ObjectLockMode | undefined;
  readonly retain_until?: string | undefined;
  readonly require_immutability?: boolean | undefined;
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
  mark_done(index: number, stored: number, deduped: number, attachments: number): void;
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

export interface SyncOptions {
  readonly folder_filter?: string[] | undefined;
  readonly force_full?: boolean | undefined;
  readonly page_size?: number | undefined;
  readonly object_lock_policy?: ObjectLockPolicy | undefined;
  readonly object_lock_request?: ObjectLockRequest | undefined;
  readonly progress?: BackupProgressReporter | undefined;
  readonly create_progress?:
    | ((folders: { name: string; total_items: number }[]) => BackupProgressReporter)
    | undefined;
  readonly should_interrupt?: (() => boolean) | undefined;
  readonly should_force_stop?: (() => boolean) | undefined;
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
}

export interface SyncResult {
  readonly snapshot: Snapshot;
  readonly manifest: Manifest;
  readonly mode: BackupSyncMode;
  readonly summary: BackupSyncSummary;
}

export interface BackupUseCase {
  sync_mailbox(tenant_id: string, mailbox_id: string, options?: SyncOptions): Promise<SyncResult>;
}
