import type { ContactsSnapshotManifest } from '@/domain/contacts/manifest';
import type {
  ContactsBackupOptions,
  ContactsBackupResult,
  ContactsRestoreOptions,
  ContactsRestoreResult,
} from '@/ports/contacts/use-case.port';
import type { DeletionResult } from '@/ports/deletion/use-case.port';
import type { VerificationOptions, VerificationResult } from '@/ports/verification/use-case.port';
import type { SdkOperationOptions } from '@/ports/atlas/progress-event.port';
import type { TargetTenantOption } from '@/ports/atlas/tenant.port';
import type { Camelize } from '@/public/case-convert';
import type { SdkQuarantineResult } from '@/ports/storage/quarantine.port';

export type ContactsSdkBackupOptions = Camelize<
  Omit<ContactsBackupOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type ContactsSdkRestoreOptions = Camelize<
  Omit<ContactsRestoreOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions &
  TargetTenantOption;
export type ContactsSdkVerificationOptions = Camelize<
  Omit<VerificationOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;

export type ContactsSdkBackupResult = Camelize<ContactsBackupResult>;
export type ContactsSdkRestoreResult = Camelize<ContactsRestoreResult>;
export type ContactsSdkVerificationResult = Camelize<VerificationResult>;
export type ContactsSdkSnapshotManifest = Camelize<ContactsSnapshotManifest>;
export type ContactsSdkDeletionResult = Camelize<DeletionResult>;

/** Mailbox arguments accept an Entra object ID or a mail address. */
export interface ContactsApi {
  backup(mailbox: string, options?: ContactsSdkBackupOptions): Promise<ContactsSdkBackupResult>;
  restore(mailbox: string, options: ContactsSdkRestoreOptions): Promise<ContactsSdkRestoreResult>;
  verify(
    mailbox: string,
    snapshotId: string,
    options?: ContactsSdkVerificationOptions,
  ): Promise<ContactsSdkVerificationResult>;
  listSnapshots(mailbox: string): Promise<ContactsSdkSnapshotManifest[]>;
  deleteMailboxData(mailbox: string): Promise<ContactsSdkDeletionResult>;
  deleteSnapshot(mailbox: string, snapshotId: string): Promise<ContactsSdkDeletionResult>;
  /**
   * Moves an unreadable snapshot manifest to `_quarantine/{storageKey}` so listings, status and
   * backups stop reporting it. Refuses an object that reads cleanly or does not exist.
   */
  quarantine(storageKey: string): Promise<SdkQuarantineResult>;
}
