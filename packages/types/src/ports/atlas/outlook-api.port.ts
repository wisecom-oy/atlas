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

export type OutlookBackupOptions = Omit<
  SyncOptions,
  'progress' | 'create_progress' | 'on_progress' | 'should_interrupt' | 'should_force_stop'
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
export type OutlookVerificationOptions = Omit<
  VerificationOptions,
  'on_progress' | 'should_interrupt'
> &
  SdkOperationOptions;
export type OutlookRestoreOptions = Omit<
  RestoreOptions,
  'create_progress' | 'on_progress' | 'should_interrupt'
> &
  SdkOperationOptions;
export type OutlookSaveOptions = Omit<
  SaveOptions,
  'create_progress' | 'on_progress' | 'should_interrupt'
> &
  SdkOperationOptions;

export interface OutlookApi {
  backup(mailboxId: string, options?: OutlookBackupOptions): Promise<SyncResult>;
  verify(snapshotId: string, options?: OutlookVerificationOptions): Promise<VerificationResult>;
  restore(snapshotId: string, options?: OutlookRestoreOptions): Promise<RestoreResult>;
  restoreMailbox(mailboxId: string, options?: OutlookRestoreOptions): Promise<RestoreResult>;
  save(snapshotId: string, options?: OutlookSaveOptions): Promise<SaveResult>;
  saveMailbox(mailboxId: string, options?: OutlookSaveOptions): Promise<SaveResult>;
  listMailboxes(): Promise<MailboxSummary[]>;
  listSnapshots(mailboxId: string): Promise<Manifest[]>;
  getSnapshotDetail(snapshotId: string): Promise<Manifest | undefined>;
  readMessage(snapshotId: string, messageRef: string): Promise<ReadMessageResult | undefined>;
  deleteMailboxData(mailboxId: string): Promise<DeletionResult>;
  deleteSnapshot(snapshotId: string): Promise<DeletionResult>;
  purgeTenantData(): Promise<DeletionResult>;
  getMailboxStats(mailboxId: string): Promise<MailboxStats>;
  checkMailboxStatus(mailboxId: string): Promise<MailboxStatusResult>;
  listAvailableMailboxes(options?: MailboxDiscoveryOptions): Promise<TenantMailbox[]>;
}
