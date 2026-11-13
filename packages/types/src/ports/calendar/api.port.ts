import type { CalendarSnapshotManifest } from '@/domain/calendar/manifest';
import type { CalendarSnapshotSummary } from '@/domain/shared/snapshot-summary';
import type {
  CalendarBackupOptions,
  CalendarBackupResult,
  CalendarRestoreOptions,
  CalendarRestoreResult,
} from '@/ports/calendar/use-case.port';
import type { DeletionResult } from '@/ports/deletion/use-case.port';
import type { VerificationOptions, VerificationResult } from '@/ports/verification/use-case.port';
import type { SdkOperationOptions } from '@/ports/atlas/progress-event.port';
import type { TargetTenantOption } from '@/ports/atlas/tenant.port';
import type { Camelize } from '@/public/case-convert';
import type { SdkQuarantineResult } from '@/ports/storage/quarantine.port';

export type CalendarSdkBackupOptions = Camelize<
  Omit<CalendarBackupOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type CalendarSdkRestoreOptions = Camelize<
  Omit<CalendarRestoreOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions &
  TargetTenantOption;
export type CalendarSdkVerificationOptions = Camelize<
  Omit<VerificationOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;

export type CalendarSdkBackupResult = Camelize<CalendarBackupResult>;
export type CalendarSdkRestoreResult = Camelize<CalendarRestoreResult>;
export type CalendarSdkVerificationResult = Camelize<VerificationResult>;
export type CalendarSdkSnapshotManifest = Camelize<CalendarSnapshotManifest>;
export type CalendarSdkSnapshotSummary = Camelize<CalendarSnapshotSummary>;
export type CalendarSdkDeletionResult = Camelize<DeletionResult>;

/** Mailbox arguments accept an Entra object ID or a mail address. */
export interface CalendarApi {
  backup(mailbox: string, options?: CalendarSdkBackupOptions): Promise<CalendarSdkBackupResult>;
  restore(mailbox: string, options: CalendarSdkRestoreOptions): Promise<CalendarSdkRestoreResult>;
  verify(
    mailbox: string,
    snapshotId: string,
    options?: CalendarSdkVerificationOptions,
  ): Promise<CalendarSdkVerificationResult>;
  listSnapshots(mailbox: string): Promise<CalendarSdkSnapshotManifest[]>;
  /** Lists a mailbox's snapshots from its summary index, without entries (#727). */
  listSnapshotSummaries(mailbox: string): Promise<CalendarSdkSnapshotSummary[]>;
  deleteMailboxData(mailbox: string): Promise<CalendarSdkDeletionResult>;
  deleteSnapshot(mailbox: string, snapshotId: string): Promise<CalendarSdkDeletionResult>;
  /**
   * Moves an unreadable snapshot manifest to `_quarantine/{storageKey}` so listings, status and
   * backups stop reporting it. Refuses an object that reads cleanly or does not exist.
   */
  quarantine(storageKey: string): Promise<SdkQuarantineResult>;
}
