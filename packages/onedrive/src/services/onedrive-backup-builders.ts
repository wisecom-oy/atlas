import type {
  OneDriveBackupResult,
  OneDriveChangeType,
  OneDriveDeltaCursor,
  OneDriveDeltaCursorRepository,
  OneDriveDeltaItem,
  OneDriveFileVersionIndexRepository,
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
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
  warnings: string[],
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
      warnings,
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

/** Appends manifest entries to the per-file version index. */
export async function append_entries_to_version_index(
  file_indexes: OneDriveFileVersionIndexRepository,
  ctx: TenantContext,
  owner_id: string,
  snapshot_id: string,
  entries: OneDriveManifestEntry[],
): Promise<void> {
  for (const entry of entries) {
    await file_indexes.append_version(ctx, owner_id, entry.file_id, {
      snapshot_id,
      backup_at: entry.backup_at,
      drive_id: entry.drive_id,
      file_name: entry.file_name,
      parent_path: entry.parent_path,
      size_bytes: entry.size_bytes,
      change_type: entry.change_type,
      ...(entry.web_url !== undefined ? { web_url: entry.web_url } : {}),
      ...(entry.storage_key !== undefined ? { storage_key: entry.storage_key } : {}),
      ...(entry.checksum !== undefined ? { checksum: entry.checksum } : {}),
      ...(entry.etag !== undefined ? { etag: entry.etag } : {}),
      ...(entry.last_modified_at !== undefined ? { last_modified_at: entry.last_modified_at } : {}),
    });
  }
}

/** Builds the success result after snapshot persistence. */
export function build_success_result(
  owner_id: string,
  snapshot: OneDriveSnapshotManifest,
  drives_scanned: number,
  files_stored: number,
  files_deduplicated: number,
  deleted_items: number,
  versions_stored: number,
  versions_unavailable: number,
  errors: string[],
  warnings: string[],
): OneDriveBackupResult {
  return {
    owner_id,
    snapshot,
    summary: {
      drives_scanned,
      files_changed: snapshot.entries.length,
      files_stored,
      files_deduplicated,
      deleted_items,
      cursor_updated: true,
      snapshot_created: true,
      versions_stored,
      versions_unavailable,
      errors,
      warnings,
      healthy: errors.length === 0,
    },
  };
}

/** Saves snapshot manifest, version index entries, and the delta cursor. */
export async function persist_snapshot_backup(
  manifests: OneDriveManifestRepository,
  file_indexes: OneDriveFileVersionIndexRepository,
  cursors: OneDriveDeltaCursorRepository,
  ctx: TenantContext,
  owner_id: string,
  snapshot: OneDriveSnapshotManifest,
  entries: OneDriveManifestEntry[],
  cursor: OneDriveDeltaCursor,
): Promise<void> {
  await manifests.save(ctx, snapshot);
  await append_entries_to_version_index(file_indexes, ctx, owner_id, snapshot.snapshot_id, entries);
  await cursors.save(ctx, cursor);
}
