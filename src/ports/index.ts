export type { ObjectStorage } from './storage/object-storage.port';

export type {
  MailboxConnector,
  MailMessage,
  MailFolder,
  DeltaSyncResult,
} from './mailbox/connector.port';

export type { ManifestRepository } from './storage/manifest-repository.port';

export type { KeyService } from './crypto/key-service.port';

export type {
  TenantContext,
  TenantContextFactory,
  TenantStorageContext,
  TenantCryptoContext,
} from './tenant/context.port';

export type { RestoreConnector, AttachmentUpload, UploadSession } from './restore/connector.port';

export type {
  BackupUseCase,
  SyncOptions,
  SyncResult,
  BackupSyncSummary,
  BackupSyncMode,
  BackupProgressReporter,
} from './backup/use-case.port';

export type { VerificationUseCase, VerificationResult } from './verification/use-case.port';

export type { RestoreUseCase, RestoreResult, RestoreOptions } from './restore/use-case.port';

export type { CatalogUseCase, MailboxSummary, ReadMessageResult } from './catalog/use-case.port';

export type { DeletionUseCase, DeletionResult } from './deletion/use-case.port';

export type {
  StorageCheckUseCase,
  StorageCheckRequest,
  StorageCheckResult,
} from './storage-check/use-case.port';

export type { StatsUseCase } from './stats/use-case.port';

export {
  OBJECT_STORAGE_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  KEY_SERVICE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  RESTORE_CONNECTOR_TOKEN,
} from './tokens/outgoing.tokens';

export {
  BACKUP_USE_CASE_TOKEN,
  VERIFICATION_USE_CASE_TOKEN,
  RESTORE_USE_CASE_TOKEN,
  CATALOG_USE_CASE_TOKEN,
  DELETION_USE_CASE_TOKEN,
  STORAGE_CHECK_USE_CASE_TOKEN,
  STATS_USE_CASE_TOKEN,
} from './tokens/use-case.tokens';
