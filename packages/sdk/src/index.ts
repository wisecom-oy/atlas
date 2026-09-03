/**
 * The public `@wisecom/atlas-sdk` surface.
 *
 * Enumerated rather than re-exported wholesale. `export * from '@wisecom/atlas-types'` published
 * every internal port, DI token and service interface as public API, which meant the snake_case
 * internals were the SDK's vocabulary and any internal rename was a consumer's breaking change
 * (issue #45). Everything below is camelCase, converted at the boundary.
 */
export { createAtlasInstance } from './atlas-instance.adapter';
export { create_storage_target as createStorageTarget } from '@wisecom/atlas-s3';
export { getGraphCost, GRAPH_SERVICE_LIMITS } from './public-values';

export type { AtlasInstance, AtlasInstanceConfig } from '@wisecom/atlas-types';
export type { StorageTarget } from '@wisecom/atlas-types';
export type { StorageTargetSdkConfig } from '@wisecom/atlas-s3';
export type { LogSink, LogFields } from '@wisecom/atlas-types';

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
} from '@wisecom/atlas-types';

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
} from '@wisecom/atlas-types';

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
} from '@wisecom/atlas-types';

export type {
  SdkOperationOptions,
  OperationProgressEvent,
  OperationProgressPhase,
  OperationProgressCallback,
} from '@wisecom/atlas-types';

export type {
  ObjectLockMode,
  ObjectLockRequest,
  BackupSyncMode,
  RehydrationWorkload,
} from '@wisecom/atlas-types';

export type {
  OperationCost,
  ServicePoolCost,
  GraphServicePool,
  GraphServiceLimits,
  OutlookServiceLimits,
  SharePointServiceLimits,
  IdentityServiceLimits,
} from '@wisecom/atlas-types';

export {
  AtlasError,
  AuthError,
  MailboxNotLicensedError,
  NotFoundError,
  ThrottledError,
  WrongPassphraseError,
  ObjectLockRetainedError,
  StorageError,
  ConfigError,
} from '@wisecom/atlas-types';
export type { AtlasErrorCode } from '@wisecom/atlas-types';
export {
  ObjectLockVersioningDisabledError,
  ObjectLockUnsupportedError,
  ObjectLockModeRejectedError,
  PreconditionFailedError,
} from '@wisecom/atlas-s3';
