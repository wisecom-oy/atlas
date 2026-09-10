import type { SyncOptions, SyncResult } from '@/ports/backup/use-case.port';
import type { VerificationOptions, VerificationResult } from '@/ports/verification/use-case.port';
import type { RestoreOptions, RestoreResult } from '@/ports/restore/use-case.port';
import type { SaveOptions, SaveResult } from '@/ports/save/use-case.port';
import type { MailboxSummary, ReadMessageResult } from '@/ports/catalog/use-case.port';
import type { Manifest } from '@/domain/manifest';
import type { DeletionResult } from '@/ports/deletion/use-case.port';
import type { MailboxStats } from '@/domain/stats';
import type { MailboxStatusResult } from '@/ports/status/use-case.port';
import type { TenantMailbox, MailboxDiscoveryOptions } from '@/ports/mail/discovery.port';
import type { SdkOperationOptions } from '@/ports/atlas/progress-event.port';
import type { Camelize } from '@/public/case-convert';

/**
 * The public Outlook surface. Every option and result is the camelCase view of the internal
 * snake_case model, converted at the SDK boundary (issue #45), and named here so that editor
 * completion and `docs/reference/sdk.md` show a type rather than a mapped-type expression.
 */
export type OutlookBackupOptions = Camelize<
  Omit<
    SyncOptions,
    'progress' | 'create_progress' | 'on_progress' | 'should_interrupt' | 'should_force_stop'
  >
> &
  SdkOperationOptions & {
    /**
     * Escalation beyond `signal`. Aborting `signal` finishes the page in flight, persists the
     * delta link for completed folders, and returns a resumable snapshot. Aborting
     * `hardStopSignal` drops the page in flight and its pending attachments, so the affected
     * folder keeps its previous delta link and is re-enumerated on the next run. Both return a
     * result with `interrupted: true`; neither throws.
     */
    readonly hardStopSignal?: AbortSignal;
  };
export type OutlookVerificationOptions = Camelize<
  Omit<VerificationOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type OutlookRestoreOptions = Camelize<
  Omit<RestoreOptions, 'create_progress' | 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type OutlookSaveOptions = Camelize<
  Omit<SaveOptions, 'create_progress' | 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;

export type OutlookBackupResult = Camelize<SyncResult>;
export type OutlookVerificationResult = Camelize<VerificationResult>;
export type OutlookRestoreResult = Camelize<RestoreResult>;
export type OutlookSaveResult = Camelize<SaveResult>;
export type OutlookMailboxSummary = Camelize<MailboxSummary>;
export type OutlookSnapshotManifest = Camelize<Manifest>;
export type OutlookReadMessageResult = Camelize<ReadMessageResult>;
export type OutlookDeletionResult = Camelize<DeletionResult>;
export type OutlookMailboxStats = Camelize<MailboxStats>;
export type OutlookMailboxStatus = Camelize<MailboxStatusResult>;
export type OutlookTenantMailbox = Camelize<TenantMailbox>;
export type OutlookMailboxDiscoveryOptions = Camelize<MailboxDiscoveryOptions>;

export interface OutlookApi {
  backup(mailboxId: string, options?: OutlookBackupOptions): Promise<OutlookBackupResult>;
  verify(
    snapshotId: string,
    options?: OutlookVerificationOptions,
  ): Promise<OutlookVerificationResult>;
  restore(snapshotId: string, options?: OutlookRestoreOptions): Promise<OutlookRestoreResult>;
  restoreMailbox(mailboxId: string, options?: OutlookRestoreOptions): Promise<OutlookRestoreResult>;
  save(snapshotId: string, options?: OutlookSaveOptions): Promise<OutlookSaveResult>;
  saveMailbox(mailboxId: string, options?: OutlookSaveOptions): Promise<OutlookSaveResult>;
  listMailboxes(): Promise<OutlookMailboxSummary[]>;
  listSnapshots(mailboxId: string): Promise<OutlookSnapshotManifest[]>;
  getSnapshotDetail(snapshotId: string): Promise<OutlookSnapshotManifest | undefined>;
  readMessage(
    snapshotId: string,
    messageRef: string,
  ): Promise<OutlookReadMessageResult | undefined>;
  deleteMailboxData(mailboxId: string): Promise<OutlookDeletionResult>;
  deleteSnapshot(snapshotId: string): Promise<OutlookDeletionResult>;
  purgeTenantData(): Promise<OutlookDeletionResult>;
  getMailboxStats(mailboxId: string): Promise<OutlookMailboxStats>;
  checkMailboxStatus(mailboxId: string): Promise<OutlookMailboxStatus>;
  listAvailableMailboxes(options?: OutlookMailboxDiscoveryOptions): Promise<OutlookTenantMailbox[]>;
}
