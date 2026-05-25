export type {
  ObjectStorage,
  ObjectStorageEtagResult,
  MultipartUploadHandle,
  StorageObjectLockMode,
  StorageObjectLockPolicy,
  StorageImmutabilityProbeRequest,
  StorageImmutabilityProbeResult,
  StorageObjectVersion,
} from './storage/object-storage.port';

export type {
  MailboxConnector,
  MailMessage,
  MailFolder,
  DeltaSyncResult,
  DeltaPageCallback,
  MessageAttachment,
} from './mail/connector.port';

export type {
  TenantMailbox,
  MailboxDiscoveryOptions,
  MailboxDiscoveryService,
} from './mail/discovery.port';

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
  ObjectLockPolicy,
} from './backup/use-case.port';

export type {
  TenantBackupOptions,
  MailboxBackupOutcome,
  TenantBackupResult,
  TenantBackupOrchestrator,
} from './backup/orchestrator.port';

export type { TenantProgressReporter } from './backup/tenant-progress.port';

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

export type { SaveOptions, SaveResult, SaveUseCase } from './save/use-case.port';

export type {
  FileSaveOptions,
  FileSaveResult,
  OneDriveSaveUseCase,
  SharePointSaveUseCase,
} from './save/file-save.port';

export type { FolderStatus, MailboxStatusResult, StatusUseCase } from './status/use-case.port';

export type { ReplicationUseCase } from './replication/use-case.port';
export type { SharePointReplicationUseCase } from './replication/sharepoint-replication.port';
export type {
  StorageTarget,
  StorageTargetConfig,
  StorageTargetFactory,
} from './replication/storage-target.port';
export type { DekValidationFn } from './replication/dek-validation.port';

export type { AtlasInstanceConfig, AtlasInstance } from './atlas/use-case.port';
export type { OutlookApi } from './atlas/outlook-api.port';
export type { OneDriveApi } from './atlas/onedrive-api.port';
export type { SharePointApi } from './atlas/sharepoint-api.port';

export type {
  UserIdentityResolver,
  ResolvedUserIdentity,
} from './identity/user-identity-resolver.port';

export type { IdentityRegistryRepository } from './identity/identity-registry-repository.port';

export type {
  OneDriveConnector,
  OneDriveDrive,
  OneDriveDeltaItem,
  OneDriveDeltaItemKind,
  OneDriveDeltaResult,
  OneDriveFileVersion,
} from './onedrive/connector.port';

export type { OneDriveManifestRepository } from './onedrive/manifest-repository.port';
export type { OneDriveDeltaCursorRepository } from './onedrive/delta-cursor-repository.port';
export type { OneDriveFileVersionIndexRepository } from './onedrive/file-version-index-repository.port';

export type {
  OneDriveBackupUseCase,
  OneDriveBackupResult,
  OneDriveBackupSummary,
  OneDriveBackupOptions,
  OneDriveCatalogUseCase,
  OneDriveVerificationUseCase,
  OneDriveVerificationResult,
} from './onedrive/use-case.port';

export type {
  OneDriveRestoreUseCase,
  OneDriveRestoreResult,
  OneDriveRestoreOptions,
  OneDriveRestoreConflictBehavior,
} from './onedrive/restore.port';

export type {
  SharePointSiteConnector,
  SharePointSite,
  SharePointDocumentLibrary,
  SharePointDeltaItem,
  SharePointDeltaItemKind,
  SharePointDeltaResult,
  SharePointFileVersion,
} from './sharepoint/connector.port';

export type { SharePointManifestRepository } from './sharepoint/manifest-repository.port';
export type { SharePointDeltaCursorRepository } from './sharepoint/delta-cursor-repository.port';
export type { SharePointFileVersionIndexRepository } from './sharepoint/file-version-index-repository.port';

export type {
  SharePointBackupUseCase,
  SharePointBackupResult,
  SharePointBackupSummary,
  SharePointBackupOptions,
  SharePointCatalogUseCase,
  SharePointVerificationUseCase,
  SharePointVerificationResult,
} from './sharepoint/use-case.port';

export type {
  SharePointRestoreUseCase,
  SharePointRestoreResult,
  SharePointRestoreOptions,
  SharePointRestoreConflictBehavior,
} from './sharepoint/restore.port';

export {
  OBJECT_STORAGE_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
  MAILBOX_DISCOVERY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  KEY_SERVICE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  RESTORE_CONNECTOR_TOKEN,
  DEK_VALIDATION_FN_TOKEN,
  STORAGE_TARGET_FACTORY_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
  IDENTITY_REGISTRY_REPOSITORY_TOKEN,
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  SHAREPOINT_DELTA_CURSOR_REPOSITORY_TOKEN,
} from './tokens/outgoing.tokens';

export {
  BACKUP_USE_CASE_TOKEN,
  VERIFICATION_USE_CASE_TOKEN,
  RESTORE_USE_CASE_TOKEN,
  CATALOG_USE_CASE_TOKEN,
  DELETION_USE_CASE_TOKEN,
  STORAGE_CHECK_USE_CASE_TOKEN,
  SAVE_USE_CASE_TOKEN,
  STATS_USE_CASE_TOKEN,
  STATUS_USE_CASE_TOKEN,
  TENANT_ORCHESTRATOR_TOKEN,
  REPLICATION_USE_CASE_TOKEN,
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  ONEDRIVE_CATALOG_USE_CASE_TOKEN,
  ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
  ONEDRIVE_RESTORE_USE_CASE_TOKEN,
  ONEDRIVE_SAVE_USE_CASE_TOKEN,
  SHAREPOINT_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
  SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_RESTORE_USE_CASE_TOKEN,
  SHAREPOINT_SAVE_USE_CASE_TOKEN,
  SHAREPOINT_CATALOG_USE_CASE_TOKEN,
} from './tokens/use-case.tokens';
