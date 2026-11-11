import type { CalendarSnapshotManifest } from '@/domain/calendar/manifest';
import type {
  BackupProgressReporter,
  NoSnapshotReason,
  ObjectLockRequest,
} from '@/ports/backup/use-case.port';
import type { DeletionResult } from '@/ports/deletion/use-case.port';
import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';
import type { VerificationOptions, VerificationResult } from '@/ports/verification/use-case.port';

export interface CalendarBackupOptions extends OperationControlOptions {
  /** Ignore stored delta links and re-read every calendar. */
  readonly force_full?: boolean | undefined;
  readonly object_lock_request?: ObjectLockRequest | undefined;
  /** CLI presenter hook; when absent the service reports progress nowhere. */
  readonly create_progress?:
    ((calendars: { name: string; total_items: number }[]) => BackupProgressReporter) | undefined;
}

export interface CalendarBackupSummary {
  readonly calendars_scanned: number;
  /** Read-only calendars (Birthdays, read-only shares) that were not backed up. */
  readonly calendars_skipped: number;
  readonly events_changed: number;
  readonly events_removed: number;
  readonly objects_stored: number;
  readonly snapshot_created: boolean;
  /** Set only when a clean run created no snapshot. */
  readonly no_snapshot_reason?: NoSnapshotReason | undefined;
  /** Data the run knowingly left out, such as attachments that are not files, one line each. */
  readonly warnings: string[];
  /**
   * Attachments the stored events carry but the backup does not capture: each item or reference
   * attachment, and each recurrence exception that has attachments of its own. Clears `healthy`.
   */
  readonly attachments_skipped: number;
  readonly errors: string[];
  /** False when any event failed or any attachment was skipped. */
  readonly healthy: boolean;
  /**
   * Newer manifests that could not be read, by key. The run then read every calendar in full and
   * wrote a fresh snapshot instead of building on them (issue #631).
   */
  readonly unreadable_keys?: string[] | undefined;
}

export interface CalendarBackupResult {
  readonly mailbox_id: string;
  readonly snapshot: CalendarSnapshotManifest | undefined;
  readonly interrupted: boolean;
  readonly summary: CalendarBackupSummary;
}

export interface CalendarRestoreOptions extends OperationControlOptions {
  readonly snapshot_id: string;
  /** Mailbox to restore into. Defaults to the source mailbox. */
  readonly target_mailbox_id?: string | undefined;
}

export interface CalendarRestoreResult {
  readonly snapshot_id: string;
  readonly events_restored: number;
  /** Events left alone because the target calendar already holds them. */
  readonly events_skipped: number;
  readonly calendars_created: number;
  readonly errors: string[];
  readonly interrupted: boolean;
}

export interface CalendarBackupUseCase {
  /** Backs up one mailbox's calendars incrementally. */
  backup_calendar(
    tenant_id: string,
    mailbox_id: string,
    options?: CalendarBackupOptions,
  ): Promise<CalendarBackupResult>;
}

export interface CalendarRestoreUseCase {
  /** Restores a calendar snapshot into the source or a target mailbox without re-inviting attendees. */
  restore_calendar(
    tenant_id: string,
    mailbox_id: string,
    options: CalendarRestoreOptions,
  ): Promise<CalendarRestoreResult>;
}

export interface CalendarCatalogUseCase {
  /** Lists a mailbox's calendar snapshots, newest first. */
  list_calendar_snapshots(
    tenant_id: string,
    mailbox_id: string,
  ): Promise<CalendarSnapshotManifest[]>;
}

export interface CalendarVerificationUseCase {
  /** Verifies every object a calendar snapshot references. */
  verify_calendar_snapshot(
    tenant_id: string,
    mailbox_id: string,
    snapshot_id: string,
    options?: VerificationOptions,
  ): Promise<VerificationResult>;
}

export interface CalendarDeletionUseCase {
  /** Deletes all backed-up calendar data for a mailbox. */
  delete_mailbox_data(tenant_id: string, mailbox_id: string): Promise<DeletionResult>;

  /** Deletes one calendar snapshot manifest. Shared content objects are kept. */
  delete_snapshot(
    tenant_id: string,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult>;
}
