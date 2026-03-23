import type { SyncOptions, SyncResult } from '@/ports/backup/use-case.port';
import type { VerificationResult } from '@/ports/verification/use-case.port';
import type { RestoreOptions, RestoreResult } from '@/ports/restore/use-case.port';
import type { SaveOptions, SaveResult } from '@/ports/save/use-case.port';
import type { MailboxSummary, ReadMessageResult } from '@/ports/catalog/use-case.port';
import type { Manifest } from '@/domain/manifest';
import type { DeletionResult } from '@/ports/deletion/use-case.port';
import type { StorageCheckRequest, StorageCheckResult } from '@/ports/storage-check/use-case.port';
import type { BucketStats, MailboxStats } from '@/domain/stats';
import type { MailboxStatusResult } from '@/ports/status/use-case.port';

export interface AtlasInstanceConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly s3Endpoint: string;
  readonly s3AccessKey: string;
  readonly s3SecretKey: string;
  readonly s3Region?: string;
  readonly encryptionPassphrase: string;
}

export interface AtlasInstance {
  backupMailbox(mailboxId: string, options?: SyncOptions): Promise<SyncResult>;
  verifySnapshot(snapshotId: string): Promise<VerificationResult>;
  restoreSnapshot(snapshotId: string, options?: RestoreOptions): Promise<RestoreResult>;
  restoreMailbox(mailboxId: string, options?: RestoreOptions): Promise<RestoreResult>;
  saveSnapshot(snapshotId: string, options?: SaveOptions): Promise<SaveResult>;
  saveMailbox(mailboxId: string, options?: SaveOptions): Promise<SaveResult>;
  listMailboxes(): Promise<MailboxSummary[]>;
  listSnapshots(mailboxId: string): Promise<Manifest[]>;
  getSnapshotDetail(snapshotId: string): Promise<Manifest | undefined>;
  readMessage(snapshotId: string, messageRef: string): Promise<ReadMessageResult | undefined>;
  deleteMailboxData(mailboxId: string): Promise<DeletionResult>;
  deleteSnapshot(snapshotId: string): Promise<DeletionResult>;
  checkStorage(request?: StorageCheckRequest): Promise<StorageCheckResult>;
  getBucketStats(): Promise<BucketStats>;
  getMailboxStats(mailboxId: string): Promise<MailboxStats>;
  checkMailboxStatus(mailboxId: string): Promise<MailboxStatusResult>;
}
