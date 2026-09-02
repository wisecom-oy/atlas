import type {
  OneDriveDeltaItem,
  OneDriveFileVersion,
  OneDriveFileVersionIndex,
  OneDriveFileVersionRecord,
  OneDriveManifestEntry,
  OneDriveSnapshotManifest,
  OneDriveVersionWatermark,
} from '@wisecom/atlas-types';

/**
 * OneDrive and SharePoint carry the same drive payload under two names: a delta item, a manifest
 * entry and a version record hold identical fields in both port definitions. These aliases give
 * the shared code a provider-neutral vocabulary while staying pinned to one declaration, so the
 * day a provider's shape diverges the callers in that package stop compiling instead of drifting
 * quietly. Aliasing beats re-declaring here: a hand-copied interface would drift in silence.
 */
export type DriveDeltaItem = OneDriveDeltaItem;
export type DriveFileVersion = OneDriveFileVersion;
export type DriveFileVersionRecord = OneDriveFileVersionRecord;
export type DriveFileVersionIndex = OneDriveFileVersionIndex;
export type DriveManifestEntry = OneDriveManifestEntry;
export type DriveSnapshotManifest = OneDriveSnapshotManifest;
export type DriveVersionWatermark = OneDriveVersionWatermark;

/**
 * What the shared version code reads from a file version index. The owning segment is named after
 * what it owns in each provider (`owner_id` on OneDrive, `site_id` on SharePoint) and is never read
 * here, so the shared functions take this view instead of either concrete index type.
 */
export interface DriveFileVersionIndexView {
  readonly file_id: string;
  readonly versions: readonly DriveFileVersionRecord[];
}

/** The two drive workloads, as they are named in progress events and default output paths. */
export type DriveWorkload = 'onedrive' | 'sharepoint';

/**
 * The connector surface the shared drive code touches. Both `OneDriveConnector` and
 * `SharePointSiteConnector` satisfy it structurally, so neither package has to adapt anything.
 */
export interface DriveContentConnector {
  download_file_content(item: DriveDeltaItem): Promise<Buffer>;
  list_file_versions(drive_id: string, item_id: string): Promise<DriveFileVersion[]>;
  download_file_version(drive_id: string, item_id: string, version_id: string): Promise<Buffer>;
  stream_file_version(
    drive_id: string,
    item_id: string,
    version_id: string,
    size_bytes?: number,
  ): Promise<AsyncIterable<Buffer>>;
}
