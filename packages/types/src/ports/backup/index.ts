export type { MailboxDeltaCursorRepository } from './delta-cursor-repository.port';
export type {
  BackupUseCase,
  SyncOptions,
  SyncResult,
  BackupSyncSummary,
  BackupSyncMode,
  NoSnapshotReason,
  BackupProgressReporter,
  ObjectLockPolicy,
  ObjectLockMode,
  ObjectLockRequest,
} from './use-case.port';
export type {
  TenantBackupOptions,
  MailboxBackupOutcome,
  TenantBackupResult,
  TenantBackupOrchestrator,
} from './orchestrator.port';
export type { TenantProgressReporter } from './tenant-progress.port';
