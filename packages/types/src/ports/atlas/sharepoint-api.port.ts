import type {
  DriveVersionRestoreOptions,
  DriveVersionRestoreResult,
} from '@/ports/drive/version-restore.port';
import type {
  SharePointBackupOptions,
  SharePointBackupResult,
  SharePointVerificationResult,
} from '@/ports/sharepoint/use-case.port';
import type {
  SharePointRestoreOptions,
  SharePointRestoreResult,
} from '@/ports/sharepoint/restore.port';
import type {
  SharePointFileVersionRecord,
  SharePointSnapshotManifest,
} from '@/domain/sharepoint-manifest';
import type { ReplicationResult } from '@/domain/replication';
import type { StorageTarget } from '@/ports/replication/storage-target.port';
import type { FileSaveOptions, FileSaveResult } from '@/ports/save/file-save.port';
import type { DeletionResult } from '@/ports/deletion/use-case.port';
import type { SharePointSite } from '@/ports/sharepoint/connector.port';
import type { SharePointStatusResult } from '@/ports/sharepoint/status.port';
import type { DriveStats } from '@/domain/stats';
import type { VerificationOptions } from '@/ports/verification/use-case.port';
import type { SdkOperationOptions } from '@/ports/atlas/progress-event.port';
import type { Camelize } from '@/public/case-convert';

export type SharePointSdkBackupOptions = Camelize<
  Omit<SharePointBackupOptions, 'create_progress' | 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type SharePointSdkVerificationOptions = Camelize<
  Omit<VerificationOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type SharePointSdkRestoreOptions = Camelize<
  Omit<SharePointRestoreOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type SharePointSdkVersionRestoreOptions = Camelize<
  Omit<DriveVersionRestoreOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type SharePointSdkSaveOptions = Camelize<
  Omit<FileSaveOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;

/**
 * `StorageTarget` is deliberately not camelised: it is a handle returned by `createStorageTarget`
 * and handed straight back, carrying a `create_context` method rather than data a consumer writes.
 */
export type SharePointSdkBackupResult = Camelize<SharePointBackupResult>;
export type SharePointSdkVerificationResult = Camelize<SharePointVerificationResult>;
export type SharePointSdkRestoreResult = Camelize<SharePointRestoreResult>;
export type SharePointSdkVersionRestoreResult = Camelize<DriveVersionRestoreResult>;
export type SharePointSdkSaveResult = Camelize<FileSaveResult>;
export type SharePointSdkSnapshotManifest = Camelize<SharePointSnapshotManifest>;
export type SharePointSdkFileVersion = Camelize<SharePointFileVersionRecord>;
export type SharePointSdkDeletionResult = Camelize<DeletionResult>;
export type SharePointSdkReplicationResult = Camelize<ReplicationResult>;
export type SharePointSdkStatusResult = Camelize<SharePointStatusResult>;
export type SharePointSdkSite = Camelize<SharePointSite>;
export type SharePointSdkStats = Camelize<DriveStats>;

export interface SharePointApi {
  /**
   * Backs up the site and, when `includeSubsites` is set, every subsite beneath it.
   * Returns one result per backed-up site, root first, so a partially covered tree is
   * visible to the caller. With `includeSubsites` unset, the single root result still
   * carries warnings naming the subsites that were not covered.
   */
  backup(
    siteId: string,
    options?: SharePointSdkBackupOptions,
  ): Promise<SharePointSdkBackupResult[]>;
  verify(
    siteId: string,
    snapshotId: string,
    options?: SharePointSdkVerificationOptions,
  ): Promise<SharePointSdkVerificationResult>;
  restore(
    siteId: string,
    options: SharePointSdkRestoreOptions,
  ): Promise<SharePointSdkRestoreResult>;
  /** Restores stored file version bytes back into a SharePoint library. */
  restoreVersion(
    siteId: string,
    options: SharePointSdkVersionRestoreOptions,
  ): Promise<SharePointSdkVersionRestoreResult>;
  save(siteId: string, options: SharePointSdkSaveOptions): Promise<SharePointSdkSaveResult>;
  listSnapshots(siteId: string): Promise<SharePointSdkSnapshotManifest[]>;
  listFileVersions(siteId: string, fileRef: string): Promise<SharePointSdkFileVersion[]>;
  listSites(): Promise<SharePointSdkSite[]>;
  resolveSite(urlOrId: string): Promise<SharePointSdkSite>;
  deleteSiteData(siteId: string): Promise<SharePointSdkDeletionResult>;
  deleteSnapshot(siteId: string, snapshotId: string): Promise<SharePointSdkDeletionResult>;
  replicateSnapshot(
    siteId: string,
    snapshotId: string,
    targets: StorageTarget[],
  ): Promise<SharePointSdkReplicationResult[]>;
  replicateAll(siteId: string, targets: StorageTarget[]): Promise<SharePointSdkReplicationResult[]>;
  rehydrateSnapshot(
    siteId: string,
    snapshotId: string,
    source: StorageTarget,
  ): Promise<SharePointSdkReplicationResult>;
  rehydrateSite(siteId: string, source: StorageTarget): Promise<SharePointSdkReplicationResult>;
  checkStatus(siteId: string): Promise<SharePointSdkStatusResult>;
  /** Aggregates SharePoint backup statistics; without siteId, tenant-wide across sites. */
  getStats(siteId?: string): Promise<SharePointSdkStats>;
}
