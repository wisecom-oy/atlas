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
import type { VerificationOptions } from '@/ports/verification/use-case.port';
import type { SdkOperationOptions } from '@/ports/atlas/progress-event.port';

export type OneDriveSdkBackupOptions = Omit<
  OneDriveBackupOptions,
  'create_progress' | 'on_progress' | 'should_interrupt'
> &
  SdkOperationOptions;
export type OneDriveSdkVerificationOptions = Omit<
  VerificationOptions,
  'on_progress' | 'should_interrupt'
> &
  SdkOperationOptions;
export type OneDriveSdkRestoreOptions = Omit<
  OneDriveRestoreOptions,
  'on_progress' | 'should_interrupt'
> &
  SdkOperationOptions;
export type OneDriveSdkSaveOptions = Omit<FileSaveOptions, 'on_progress' | 'should_interrupt'> &
  SdkOperationOptions;

export interface OneDriveApi {
  backup(ownerId: string, options?: OneDriveSdkBackupOptions): Promise<OneDriveBackupResult>;
  verify(
    ownerId: string,
    snapshotId: string,
    options?: OneDriveSdkVerificationOptions,
  ): Promise<OneDriveVerificationResult>;
  restore(ownerId: string, options: OneDriveSdkRestoreOptions): Promise<OneDriveRestoreResult>;
  save(ownerId: string, options: OneDriveSdkSaveOptions): Promise<FileSaveResult>;
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
