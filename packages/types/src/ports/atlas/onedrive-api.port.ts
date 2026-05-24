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

export interface OneDriveApi {
  backup(ownerId: string, options?: OneDriveBackupOptions): Promise<OneDriveBackupResult>;
  verify(ownerId: string, snapshotId: string): Promise<OneDriveVerificationResult>;
  restore(ownerId: string, options: OneDriveRestoreOptions): Promise<OneDriveRestoreResult>;
  listSnapshots(ownerId: string): Promise<OneDriveSnapshotManifest[]>;
  listFileVersions(ownerId: string, fileRef: string): Promise<OneDriveFileVersionRecord[]>;
}
