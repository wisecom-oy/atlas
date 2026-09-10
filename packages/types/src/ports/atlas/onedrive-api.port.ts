import type {
  DriveVersionRestoreOptions,
  DriveVersionRestoreResult,
} from '@/ports/drive/version-restore.port';
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
import type { DriveStats } from '@/domain/stats';
import type { VerificationOptions } from '@/ports/verification/use-case.port';
import type { SdkOperationOptions } from '@/ports/atlas/progress-event.port';
import type { Camelize } from '@/public/case-convert';

export type OneDriveSdkBackupOptions = Camelize<
  Omit<OneDriveBackupOptions, 'create_progress' | 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type OneDriveSdkVerificationOptions = Camelize<
  Omit<VerificationOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type OneDriveSdkRestoreOptions = Camelize<
  Omit<OneDriveRestoreOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type OneDriveSdkVersionRestoreOptions = Camelize<
  Omit<DriveVersionRestoreOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type OneDriveSdkSaveOptions = Camelize<
  Omit<FileSaveOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;

/**
 * `StorageTarget` is deliberately not camelised: it is a handle returned by `createStorageTarget`
 * and handed straight back, carrying a `create_context` method rather than data a consumer writes.
 * Its *config* is camelCase, which is the shape a consumer does author.
 */
export type OneDriveSdkBackupResult = Camelize<OneDriveBackupResult>;
export type OneDriveSdkVerificationResult = Camelize<OneDriveVerificationResult>;
export type OneDriveSdkRestoreResult = Camelize<OneDriveRestoreResult>;
export type OneDriveSdkVersionRestoreResult = Camelize<DriveVersionRestoreResult>;
export type OneDriveSdkSaveResult = Camelize<FileSaveResult>;
export type OneDriveSdkSnapshotManifest = Camelize<OneDriveSnapshotManifest>;
export type OneDriveSdkFileVersion = Camelize<OneDriveFileVersionRecord>;
export type OneDriveSdkDeletionResult = Camelize<DeletionResult>;
export type OneDriveSdkReplicationResult = Camelize<ReplicationResult>;
export type OneDriveSdkStatusResult = Camelize<OneDriveStatusResult>;
export type OneDriveSdkStats = Camelize<DriveStats>;

export interface OneDriveApi {
  backup(ownerId: string, options?: OneDriveSdkBackupOptions): Promise<OneDriveSdkBackupResult>;
  verify(
    ownerId: string,
    snapshotId: string,
    options?: OneDriveSdkVerificationOptions,
  ): Promise<OneDriveSdkVerificationResult>;
  restore(ownerId: string, options: OneDriveSdkRestoreOptions): Promise<OneDriveSdkRestoreResult>;
  /** Restores stored file version bytes back into OneDrive. */
  restoreVersion(
    ownerId: string,
    options: OneDriveSdkVersionRestoreOptions,
  ): Promise<OneDriveSdkVersionRestoreResult>;
  save(ownerId: string, options: OneDriveSdkSaveOptions): Promise<OneDriveSdkSaveResult>;
  listSnapshots(ownerId: string): Promise<OneDriveSdkSnapshotManifest[]>;
  listFileVersions(ownerId: string, fileRef: string): Promise<OneDriveSdkFileVersion[]>;
  deleteOwnerData(ownerId: string): Promise<OneDriveSdkDeletionResult>;
  deleteSnapshot(ownerId: string, snapshotId: string): Promise<OneDriveSdkDeletionResult>;
  replicateSnapshot(
    ownerId: string,
    snapshotId: string,
    targets: StorageTarget[],
  ): Promise<OneDriveSdkReplicationResult[]>;
  replicateAll(ownerId: string, targets: StorageTarget[]): Promise<OneDriveSdkReplicationResult[]>;
  rehydrateSnapshot(
    ownerId: string,
    snapshotId: string,
    source: StorageTarget,
  ): Promise<OneDriveSdkReplicationResult>;
  rehydrateOwner(ownerId: string, source: StorageTarget): Promise<OneDriveSdkReplicationResult>;
  checkStatus(ownerId: string): Promise<OneDriveSdkStatusResult>;
  /** Aggregates OneDrive backup statistics; without ownerId, tenant-wide across drives. */
  getStats(ownerId?: string): Promise<OneDriveSdkStats>;
}
