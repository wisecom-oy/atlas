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

export type SharePointSdkBackupOptions = Omit<
  SharePointBackupOptions,
  'create_progress' | 'on_progress' | 'should_interrupt'
> &
  SdkOperationOptions;
export type SharePointSdkVerificationOptions = Omit<
  VerificationOptions,
  'on_progress' | 'should_interrupt'
> &
  SdkOperationOptions;
export type SharePointSdkRestoreOptions = Omit<
  SharePointRestoreOptions,
  'on_progress' | 'should_interrupt'
> &
  SdkOperationOptions;
export type SharePointSdkVersionRestoreOptions = Omit<
  DriveVersionRestoreOptions,
  'on_progress' | 'should_interrupt'
> &
  SdkOperationOptions;
export type SharePointSdkSaveOptions = Omit<FileSaveOptions, 'on_progress' | 'should_interrupt'> &
  SdkOperationOptions;

export interface SharePointApi {
  /**
   * Backs up the site and, when `include_subsites` is set, every subsite beneath it.
   * Returns one result per backed-up site, root first, so a partially covered tree is
   * visible to the caller. With `include_subsites` unset, the single root result still
   * carries warnings naming the subsites that were not covered.
   */
  backup(siteId: string, options?: SharePointSdkBackupOptions): Promise<SharePointBackupResult[]>;
  verify(
    siteId: string,
    snapshotId: string,
    options?: SharePointSdkVerificationOptions,
  ): Promise<SharePointVerificationResult>;
  restore(siteId: string, options: SharePointSdkRestoreOptions): Promise<SharePointRestoreResult>;
  /** Restores stored file version bytes back into a SharePoint library. */
  restoreVersion(
    siteId: string,
    options: SharePointSdkVersionRestoreOptions,
  ): Promise<DriveVersionRestoreResult>;
  save(siteId: string, options: SharePointSdkSaveOptions): Promise<FileSaveResult>;
  listSnapshots(siteId: string): Promise<SharePointSnapshotManifest[]>;
  listFileVersions(siteId: string, fileRef: string): Promise<SharePointFileVersionRecord[]>;
  listSites(): Promise<SharePointSite[]>;
  resolveSite(urlOrId: string): Promise<SharePointSite>;
  deleteSiteData(siteId: string): Promise<DeletionResult>;
  deleteSnapshot(siteId: string, snapshotId: string): Promise<DeletionResult>;
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
  checkStatus(siteId: string): Promise<SharePointStatusResult>;
  /** Aggregates SharePoint backup statistics; without siteId, tenant-wide across sites. */
  getStats(siteId?: string): Promise<DriveStats>;
}
