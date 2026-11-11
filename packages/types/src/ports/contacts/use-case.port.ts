import type { ContactsSnapshotManifest } from '@/domain/contacts/manifest';
import type {
  BackupProgressReporter,
  NoSnapshotReason,
  ObjectLockRequest,
} from '@/ports/backup/use-case.port';
import type { DeletionResult } from '@/ports/deletion/use-case.port';
import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';
import type { VerificationOptions, VerificationResult } from '@/ports/verification/use-case.port';

export interface ContactsBackupOptions extends OperationControlOptions {
  /** Ignore stored delta links and re-read every folder. */
  readonly force_full?: boolean | undefined;
  readonly object_lock_request?: ObjectLockRequest | undefined;
  /** CLI presenter hook; when absent the service reports progress nowhere. */
  readonly create_progress?:
    ((folders: { name: string; total_items: number }[]) => BackupProgressReporter) | undefined;
}

export interface ContactsBackupSummary {
  readonly folders_scanned: number;
  readonly contacts_changed: number;
  readonly contacts_removed: number;
  readonly objects_stored: number;
  readonly snapshot_created: boolean;
  /** Set only when a clean run created no snapshot. */
  readonly no_snapshot_reason?: NoSnapshotReason | undefined;
  readonly errors: string[];
  readonly healthy: boolean;
  /**
   * Newer manifests that could not be read, by key. The run then read every folder in full and
   * wrote a fresh snapshot instead of building on them (issue #631).
   */
  readonly unreadable_keys?: string[] | undefined;
}

export interface ContactsBackupResult {
  readonly mailbox_id: string;
  readonly snapshot: ContactsSnapshotManifest | undefined;
  readonly interrupted: boolean;
  readonly summary: ContactsBackupSummary;
}

export interface ContactsRestoreOptions extends OperationControlOptions {
  readonly snapshot_id: string;
  /** Mailbox to restore into. Defaults to the source mailbox. */
  readonly target_mailbox_id?: string | undefined;
}

export interface ContactsRestoreResult {
  readonly snapshot_id: string;
  readonly contacts_restored: number;
  /** Contacts left alone because the target folder already holds a matching contact. */
  readonly contacts_skipped: number;
  readonly folders_created: number;
  readonly errors: string[];
  readonly interrupted: boolean;
}

export interface ContactsBackupUseCase {
  /** Backs up one mailbox's personal contacts incrementally. */
  backup_contacts(
    tenant_id: string,
    mailbox_id: string,
    options?: ContactsBackupOptions,
  ): Promise<ContactsBackupResult>;
}

export interface ContactsRestoreUseCase {
  /** Restores a contacts snapshot into the source or a target mailbox without overwriting existing contacts. */
  restore_contacts(
    tenant_id: string,
    mailbox_id: string,
    options: ContactsRestoreOptions,
  ): Promise<ContactsRestoreResult>;
}

export interface ContactsCatalogUseCase {
  /** Lists a mailbox's contacts snapshots, newest first. */
  list_contacts_snapshots(
    tenant_id: string,
    mailbox_id: string,
  ): Promise<ContactsSnapshotManifest[]>;
}

export interface ContactsVerificationUseCase {
  /** Verifies every object a contacts snapshot references. */
  verify_contacts_snapshot(
    tenant_id: string,
    mailbox_id: string,
    snapshot_id: string,
    options?: VerificationOptions,
  ): Promise<VerificationResult>;
}

export interface ContactsDeletionUseCase {
  /** Deletes all backed-up contacts data for a mailbox. */
  delete_mailbox_data(tenant_id: string, mailbox_id: string): Promise<DeletionResult>;

  /** Deletes one contacts snapshot manifest. Shared content objects are kept. */
  delete_snapshot(
    tenant_id: string,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult>;
}
