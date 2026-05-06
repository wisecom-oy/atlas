import type {
  OneDriveBackupResult,
  OneDriveChangeType,
  OneDriveDeltaItem,
  OneDriveManifestEntry,
  OneDriveSnapshotManifest,
} from '@atlas/types';
import type { VersionSyncResult } from '@/services/onedrive-version-sync';

export function build_deleted_entry(
  item: OneDriveDeltaItem,
  change_type: OneDriveChangeType,
): OneDriveManifestEntry {
  return {
    file_id: item.item_id,
    drive_id: item.drive_id,
    file_name: item.file_name,
    parent_path: item.parent_path,
    size_bytes: item.size_bytes,
    backup_at: new Date().toISOString(),
    change_type,
    ...(item.web_url !== undefined && { web_url: item.web_url }),
    ...(item.last_modified_at !== undefined && { last_modified_at: item.last_modified_at }),
    ...(item.etag !== undefined && { etag: item.etag }),
  };
}

export function build_stored_entry(
  item: OneDriveDeltaItem,
  storage_key: string,
  checksum: string,
  change_type: OneDriveChangeType,
): OneDriveManifestEntry {
  return {
    file_id: item.item_id,
    drive_id: item.drive_id,
    file_name: item.file_name,
    parent_path: item.parent_path,
    size_bytes: item.size_bytes,
    storage_key,
    checksum,
    backup_at: new Date().toISOString(),
    change_type,
    ...(item.web_url !== undefined && { web_url: item.web_url }),
    ...(item.last_modified_at !== undefined && { last_modified_at: item.last_modified_at }),
    ...(item.etag !== undefined && { etag: item.etag }),
  };
}

export function build_snapshot_manifest(
  tenant_id: string,
  owner_id: string,
  entries: OneDriveManifestEntry[],
  snapshot_id: string,
  created_at: Date,
  owner_email?: string,
  owner_display_name?: string,
): OneDriveSnapshotManifest {
  return {
    id: `${owner_id}-${snapshot_id}`,
    tenant_id,
    owner_id,
    ...(owner_email !== undefined && { owner_email }),
    ...(owner_display_name !== undefined && { owner_display_name }),
    snapshot_id,
    created_at,
    total_files: entries.length,
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    entries,
  };
}

export function build_empty_result(
  owner_id: string,
  drives_scanned: number,
  files_stored: number,
  files_deduplicated: number,
  deleted_items: number,
  versions_stored: number,
  versions_unavailable: number,
  errors: string[],
  healthy: boolean,
): OneDriveBackupResult {
  return {
    owner_id,
    snapshot: undefined,
    summary: {
      drives_scanned,
      files_changed: 0,
      files_stored,
      files_deduplicated,
      deleted_items,
      cursor_updated: true,
      snapshot_created: false,
      versions_stored,
      versions_unavailable,
      errors,
      healthy,
    },
  };
}

export function accumulate_version_stats(
  result: VersionSyncResult,
  current: {
    total_versions_stored: number;
    total_versions_unavailable: number;
    total_versions_failed: number;
  },
  set: (stored: number, unavailable: number, failed: number) => void,
): void {
  set(
    current.total_versions_stored + result.new_versions_stored,
    current.total_versions_unavailable + result.versions_unavailable,
    current.total_versions_failed + result.versions_failed,
  );
}
