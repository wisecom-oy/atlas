import type { ObjectLockPolicy, ObjectLockRequest, SyncResult } from '@/ports/backup/use-case.port';
import type { TenantProgressReporter } from '@/ports/backup/tenant-progress.port';

export interface TenantBackupOptions {
  concurrency?: number | undefined;
  force_full?: boolean | undefined;
  page_size?: number | undefined;
  /** Object Lock retention request applied to every mailbox in the run. */
  object_lock_request?: ObjectLockRequest | undefined;
  object_lock_policy?: ObjectLockPolicy | undefined;
  progress?: TenantProgressReporter | undefined;
  should_interrupt?: (() => boolean) | undefined;
  should_force_stop?: (() => boolean) | undefined;
}

export interface MailboxBackupOutcome {
  readonly owner_id: string;
  readonly result?: SyncResult;
  readonly error?: string;
}

export interface TenantBackupResult {
  readonly outcomes: MailboxBackupOutcome[];
  readonly total_mailboxes: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly interrupted: boolean;
  readonly elapsed_ms: number;
}

export interface TenantBackupOrchestrator {
  backup_tenant(tenant_id: string, options?: TenantBackupOptions): Promise<TenantBackupResult>;
}
