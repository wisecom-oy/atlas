export type {
  ContactsConnector,
  ContactFolderDelta,
  GraphContactFolder,
  GraphContactPayload,
} from './connector.port';
export type { ContactsManifestRepository, ContactsDeltaCursorRepository } from './repository.port';
export type {
  ContactsBackupOptions,
  ContactsBackupSummary,
  ContactsBackupResult,
  ContactsRestoreOptions,
  ContactsRestoreResult,
  ContactsBackupUseCase,
  ContactsRestoreUseCase,
  ContactsCatalogUseCase,
  ContactsVerificationUseCase,
  ContactsDeletionUseCase,
} from './use-case.port';
export type {
  ContactsApi,
  ContactsSdkBackupOptions,
  ContactsSdkBackupResult,
  ContactsSdkRestoreOptions,
  ContactsSdkRestoreResult,
  ContactsSdkVerificationOptions,
  ContactsSdkVerificationResult,
  ContactsSdkSnapshotManifest,
  ContactsSdkDeletionResult,
} from './api.port';
