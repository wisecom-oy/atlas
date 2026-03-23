import type { SyncResult } from '@/ports/backup/use-case.port';
import type { TenantProgressReporter } from '@/ports/backup/tenant-progress.port';

export interface TenantBackupOptions {
  concurrency?: number;
  force_full?: boolean;
  page_size?: number;
  progress?: TenantProgressReporter;
  should_interrupt?: () => boolean;
  should_force_stop?: () => boolean;
}

export interface MailboxBackupOutcome {
  readonly mailbox_id: string;
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
