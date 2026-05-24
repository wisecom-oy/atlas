import type {
  SharePointBackupOptions,
  SharePointBackupResult,
  SharePointVerificationResult,
} from '@/ports/sharepoint/use-case.port';
import type {
  SharePointRestoreOptions,
  SharePointRestoreResult,
} from '@/ports/sharepoint/restore.port';
import type { ReplicationResult } from '@/domain/replication';
import type { StorageTarget } from '@/ports/replication/storage-target.port';
import type { FileSaveOptions, FileSaveResult } from '@/ports/save/file-save.port';

export interface SharePointApi {
  backup(siteId: string, options?: SharePointBackupOptions): Promise<SharePointBackupResult>;
  verify(siteId: string, snapshotId: string): Promise<SharePointVerificationResult>;
  restore(siteId: string, options: SharePointRestoreOptions): Promise<SharePointRestoreResult>;
  save(siteId: string, options: FileSaveOptions): Promise<FileSaveResult>;
  replicateSnapshot(
    siteId: string,
    snapshotId: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]>;
  replicateAll(siteId: string, targets: StorageTarget[]): Promise<ReplicationResult[]>;
  rehydrateSnapshot(
    siteId: string,
    snapshotId: string,
    source: StorageTarget,
  ): Promise<ReplicationResult>;
  rehydrateSite(siteId: string, source: StorageTarget): Promise<ReplicationResult>;
}
