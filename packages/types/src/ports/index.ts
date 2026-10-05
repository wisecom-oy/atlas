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
  WellKnownMailFolder,
  MailFolderListOptions,
  ExcludedFolder,
  FolderExclusionReason,
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
export type { MailboxDeltaCursorRepository } from './backup/delta-cursor-repository.port';

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
  NoSnapshotReason,
  BackupProgressReporter,
  ObjectLockPolicy,
  ObjectLockMode,
  ObjectLockRequest,
} from './backup/use-case.port';

export type {
  TenantBackupOptions,
  MailboxBackupOutcome,
  TenantBackupResult,
  TenantBackupOrchestrator,
} from './backup/orchestrator.port';

export type { TenantProgressReporter } from './backup/tenant-progress.port';

export type {
  VerificationUseCase,
  VerificationResult,
  VerificationOptions,
} from './verification/use-case.port';

export type { RestoreUseCase, RestoreResult, RestoreOptions } from './restore/use-case.port';

export type { CatalogUseCase, MailboxSummary, ReadMessageResult } from './catalog/use-case.port';

export type { DeletionUseCase, DeletionResult } from './deletion/use-case.port';

export type { DekRewrapUseCase, DekRewrapResult } from './keys/dek-rewrap.port';

export type {
  StorageCheckUseCase,
  StorageCheckRequest,
  StorageCheckResult,
} from './storage-check/use-case.port';

export type { StatsUseCase } from './stats/use-case.port';

export type { SaveOptions, SaveResult, SaveUseCase } from './save/use-case.port';

export type {
  TransferProgressReporter,
  TransferProgressUpdate,
} from './shared/transfer-progress.port';

export type {
  FileSaveOptions,
  FileSaveResult,
  OneDriveSaveUseCase,
  SharePointSaveUseCase,
} from './save/file-save.port';

export type { FolderStatus, MailboxStatusResult, StatusUseCase } from './status/use-case.port';

export type { ReplicationUseCase } from './replication/use-case.port';
export type { SharePointReplicationUseCase } from './replication/sharepoint-replication.port';
export type { OneDriveReplicationUseCase } from './replication/onedrive-replication.port';
export type {
  StorageTarget,
  StorageTargetConfig,
  StorageTargetFactory,
} from './replication/storage-target.port';
export type { DekValidationFn } from './replication/dek-validation.port';

export type { StorageDisposer } from './storage/storage-disposer.port';

export type { AtlasInstanceConfig, AtlasInstance } from './atlas/use-case.port';
export type { LogSink, LogFields } from './atlas/log-sink.port';
export type {
  OutlookApi,
  OutlookBackupOptions,
  OutlookBackupResult,
  OutlookVerificationOptions,
  OutlookVerificationResult,
  OutlookRestoreOptions,
  OutlookRestoreResult,
  OutlookSaveOptions,
  OutlookSaveResult,
  OutlookMailboxSummary,
  OutlookSnapshotManifest,
  OutlookReadMessageResult,
  OutlookDeletionResult,
  OutlookMailboxStats,
  OutlookMailboxStatus,
  OutlookTenantMailbox,
  OutlookMailboxDiscoveryOptions,
} from './atlas/outlook-api.port';
export type {
  OneDriveApi,
  OneDriveSdkBackupOptions,
  OneDriveSdkBackupResult,
  OneDriveSdkVerificationOptions,
  OneDriveSdkVerificationResult,
  OneDriveSdkRestoreOptions,
  OneDriveSdkRestoreResult,
  OneDriveSdkVersionRestoreOptions,
  OneDriveSdkVersionRestoreResult,
  OneDriveSdkSaveOptions,
  OneDriveSdkSaveResult,
  OneDriveSdkSnapshotManifest,
  OneDriveSdkFileVersion,
  OneDriveSdkDeletionResult,
  OneDriveSdkReplicationResult,
  OneDriveSdkStatusResult,
  OneDriveSdkStats,
} from './atlas/onedrive-api.port';
export type {
  SharePointApi,
  SharePointSdkBackupOptions,
  SharePointSdkBackupResult,
  SharePointSdkVerificationOptions,
  SharePointSdkVerificationResult,
  SharePointSdkRestoreOptions,
  SharePointSdkRestoreResult,
  SharePointSdkVersionRestoreOptions,
  SharePointSdkVersionRestoreResult,
  SharePointSdkSaveOptions,
  SharePointSdkSaveResult,
  SharePointSdkSnapshotManifest,
  SharePointSdkFileVersion,
  SharePointSdkDeletionResult,
  SharePointSdkReplicationResult,
  SharePointSdkStatusResult,
  SharePointSdkSite,
  SharePointSdkStats,
} from './atlas/sharepoint-api.port';
export type {
  OperationProgressEvent,
  OperationProgressPhase,
  OperationProgressCallback,
  SdkOperationOptions,
  OperationControlOptions,
} from './atlas/progress-event.port';

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

export type { OneDriveDeletionUseCase } from './onedrive/deletion.port';

export type {
  OneDriveStatusUseCase,
  OneDriveStatusResult,
  OneDriveDriveStatus,
} from './onedrive/status.port';

export type {
  OneDriveRestoreUseCase,
  OneDriveRestoreResult,
  OneDriveRestoreOptions,
  OneDriveRestoreConflictBehavior,
} from './onedrive/restore.port';

export type { OneDriveVersionRestoreUseCase } from './onedrive/use-case.port';
export type { SharePointVersionRestoreUseCase } from './sharepoint/use-case.port';

export type {
  DriveVersionPlacement,
  DriveVersionRestoreOptions,
  DriveRestoredVersion,
  DriveVersionRestoreResult,
} from './drive/version-restore.port';

export type { LargeFileContent, StreamedFileContent } from './drive/large-file-content.port';

export type {
  SharePointSiteConnector,
  SharePointSite,
  SharePointSubsiteTree,
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
  SharePointSiteTreeBackupUseCase,
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

export type { SharePointDeletionUseCase } from './sharepoint/deletion.port';

export type {
  SharePointStatusUseCase,
  SharePointStatusResult,
  SharePointLibraryStatus,
} from './sharepoint/status.port';

export type * from './storage/storage-inventory.port';
export type * from './storage-usage/use-case.port';

// Every token is public: the CLI, SDK and adapter packages resolve them from the container.
export * from './tokens/outgoing.tokens';
export * from './tokens/use-case.tokens';
