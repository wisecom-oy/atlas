import type {
  OneDriveBackupOptions,
  OneDriveBackupResult,
  OneDriveVerificationResult,
} from '@/ports/onedrive/use-case.port';
import type { OneDriveRestoreOptions, OneDriveRestoreResult } from '@/ports/onedrive/restore.port';
import type {
  OneDriveSnapshotManifest,
  OneDriveFileVersionRecord,
} from '@/domain/onedrive-manifest';
import type { FileSaveOptions, FileSaveResult } from '@/ports/save/file-save.port';
import type { DeletionResult } from '@/ports/deletion/use-case.port';
import type { ReplicationResult } from '@/domain/replication';
import type { StorageTarget } from '@/ports/replication/storage-target.port';
import type { OneDriveStatusResult } from '@/ports/onedrive/status.port';

export interface OneDriveApi {
  backup(ownerId: string, options?: OneDriveBackupOptions): Promise<OneDriveBackupResult>;
  verify(ownerId: string, snapshotId: string): Promise<OneDriveVerificationResult>;
  restore(ownerId: string, options: OneDriveRestoreOptions): Promise<OneDriveRestoreResult>;
  save(ownerId: string, options: FileSaveOptions): Promise<FileSaveResult>;
  listSnapshots(ownerId: string): Promise<OneDriveSnapshotManifest[]>;
  listFileVersions(ownerId: string, fileRef: string): Promise<OneDriveFileVersionRecord[]>;
  deleteOwnerData(ownerId: string): Promise<DeletionResult>;
  deleteSnapshot(ownerId: string, snapshotId: string): Promise<DeletionResult>;
  replicateSnapshot(
    ownerId: string,
    snapshotId: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]>;
  replicateAll(ownerId: string, targets: StorageTarget[]): Promise<ReplicationResult[]>;
  rehydrateSnapshot(
    ownerId: string,
    snapshotId: string,
    source: StorageTarget,
  ): Promise<ReplicationResult>;
  rehydrateOwner(ownerId: string, source: StorageTarget): Promise<ReplicationResult>;
  checkStatus(ownerId: string): Promise<OneDriveStatusResult>;
}
