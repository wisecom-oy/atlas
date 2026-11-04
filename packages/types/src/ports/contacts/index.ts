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
