// Deliberately not shared with the OneDrive copy (#306): 68 differing lines of 432. The
// manifests they build differ in their identity fields and in what each provider records per
// entry, so the shared version would be generic over almost every line.
import type {
  HeldOwnerLease,
  ManifestObjectLockPolicy,
  NoSnapshotReason,
  SharePointBackupResult,
  SharePointChangeType,
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  SharePointDeltaItem,
  SharePointFileVersionIndex,
  SharePointFileVersionIndexRepository,
  SharePointFileVersionRecord,
  SharePointManifestEntry,
  SharePointManifestRepository,
  SharePointSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import type { PackageReport } from '@wisecom/atlas-core/services/shared/package-item-reporter';
import type { SharePointLibraryScanResult } from '@/services/backup/backup-library-scan';
import type { RunVersionCollector, VersionSyncResult } from '@/services/versioning/version-sync';
import { count_file_entries, records_file_content } from '@wisecom/atlas-drive/shared/entry-kind';

/**
 * Flattens per-library package reports into backup summary warnings.
 *
 * Emits one informational line for the run plus every per-notebook
 * incompleteness warning, so a notebook that lost section files is visible
 * even though its files are stored as ordinary items.
 */
export function build_package_warnings(reports: readonly PackageReport[]): string[] {
  const detected = reports.reduce((n, r) => n + r.notebooks_detected, 0);
  if (detected === 0) return [];
  const sections = reports.reduce((n, r) => n + r.section_files_backed_up, 0);
  return [
    `OneNote notebooks detected: ${detected} (${sections} section file(s) backed up as ordinary files).`,
    ...reports.flatMap((r) => r.warnings),
  ];
}

export function build_deleted_entry(
  item: SharePointDeltaItem,
  change_type: SharePointChangeType,
  library_name: string,
): SharePointManifestEntry {
  return {
    file_id: item.item_id,
    drive_id: item.drive_id,
    library_name,
    file_name: item.file_name,
    parent_path: item.parent_path,
    size_bytes: item.size_bytes,
    backup_at: new Date().toISOString(),
    change_type,
    ...(item.web_url !== undefined && { web_url: item.web_url }),
    ...(item.last_modified_at !== undefined && { last_modified_at: item.last_modified_at }),
    ...(item.etag !== undefined && { etag: item.etag }),
    ...(item.file_system_info !== undefined && { file_system_info: item.file_system_info }),
    ...(item.created_by !== undefined && { created_by: item.created_by }),
    ...(item.last_modified_by !== undefined && { last_modified_by: item.last_modified_by }),
  };
}

export function build_stored_entry(
  item: SharePointDeltaItem,
  storage_key: string,
  checksum: string,
  change_type: SharePointChangeType,
  library_name: string,
): SharePointManifestEntry {
  return {
    file_id: item.item_id,
    drive_id: item.drive_id,
    library_name,
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
    ...(item.file_system_info !== undefined && { file_system_info: item.file_system_info }),
    ...(item.created_by !== undefined && { created_by: item.created_by }),
    ...(item.last_modified_by !== undefined && { last_modified_by: item.last_modified_by }),
  };
}

export function build_snapshot_manifest(
  tenant_id: string,
  site_id: string,
  entries: SharePointManifestEntry[],
  snapshot_id: string,
  created_at: Date,
  site_url?: string,
  site_display_name?: string,
  object_lock?: ManifestObjectLockPolicy,
): SharePointSnapshotManifest {
  return {
    id: `${site_id}-${snapshot_id}`,
    tenant_id,
    site_id,
    ...(site_url !== undefined && { site_url }),
    ...(site_display_name !== undefined && { site_display_name }),
    snapshot_id,
    created_at,
    total_files: count_file_entries(entries),
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    ...(object_lock !== undefined && { object_lock }),
    entries,
  };
}

/** The scan figures a run that created a snapshot reports. */
type SnapshotScanFigures = Pick<
  SharePointLibraryScanResult,
  | 'entries'
  | 'files_stored'
  | 'files_deduplicated'
  | 'deleted_items'
  | 'version_stats'
  | 'interrupted'
>;

/** Builds the result of a run that created and persisted a snapshot. */
export function build_success_result(
  site_id: string,
  snapshot: SharePointSnapshotManifest,
  scan: SnapshotScanFigures,
  libraries_scanned: number,
  errors: string[],
  warnings: string[],
  healthy: boolean,
): SharePointBackupResult {
  return {
    site_id,
    snapshot,
    interrupted: scan.interrupted,
    summary: {
      libraries_scanned,
      files_changed: scan.entries.length,
      files_stored: scan.files_stored,
      files_deduplicated: scan.files_deduplicated,
      deleted_items: scan.deleted_items,
      cursor_updated: true,
      snapshot_created: true,
      versions_stored: scan.version_stats.total_versions_stored,
      versions_unavailable: scan.version_stats.total_versions_unavailable,
      errors,
      warnings,
      healthy,
    },
  };
}

/** The change-tracking maps a cursor carries from one run to the next. */
type CursorTracking = Pick<
  SharePointDeltaCursor,
  | 'previous_path_by_file_id'
  | 'previous_name_by_file_id'
  | 'previous_etag_by_file_id'
  | 'previous_kind_by_file_id'
  | 'permission_digest_by_item_id'
>;

/**
 * Builds the delta cursor a run saves. `snapshot_id` is the snapshot the run wrote or left as the
 * newest, or `null` when the site has none: the next run resumes the cursor only while that
 * snapshot's manifest still exists (issue #725).
 */
export function build_delta_cursor(
  site_id: string,
  delta_link_by_drive: Record<string, string>,
  tracking: CursorTracking,
  failed_items: NonNullable<SharePointDeltaCursor['failed_items']>,
  versions: Pick<RunVersionCollector, 'watermarks' | 'pending'>,
  snapshot_id: string | null,
): SharePointDeltaCursor {
  return {
    site_id,
    delta_link_by_drive,
    ...tracking,
    version_watermark_by_file_id: versions.watermarks,
    pending_versions_by_file_id: versions.pending,
    failed_items,
    updated_at: new Date().toISOString(),
    snapshot_id,
  };
}

/**
 * Builds the result of a run that created no snapshot. `cursor_updated` says whether the run saved
 * its delta cursor: a run cancelled before its scan finished writes none (issue #693).
 */
export function build_empty_result(
  site_id: string,
  libraries_scanned: number,
  files_stored: number,
  files_deduplicated: number,
  deleted_items: number,
  versions_stored: number,
  versions_unavailable: number,
  errors: string[],
  warnings: string[],
  healthy: boolean,
  interrupted: boolean,
  cursor_updated: boolean,
  no_snapshot_reason?: NoSnapshotReason,
): SharePointBackupResult {
  return {
    site_id,
    snapshot: undefined,
    interrupted,
    summary: {
      libraries_scanned,
      files_changed: 0,
      files_stored,
      files_deduplicated,
      deleted_items,
      cursor_updated,
      snapshot_created: false,
      ...(no_snapshot_reason !== undefined && { no_snapshot_reason }),
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

/**
 * Folds manifest entries and version downloads into per-file groups for the run's single index
 * object. Only entries that recorded file content start a row: a folder entry or a sharing-only
 * change has no version of its own.
 */
export function build_run_version_indexes(
  site_id: string,
  snapshot_id: string,
  entries: SharePointManifestEntry[],
  collected_rows: Map<string, SharePointFileVersionRecord[]>,
): SharePointFileVersionIndex[] {
  const versions_by_file = new Map<string, SharePointFileVersionRecord[]>();
  const add = (file_id: string, record: SharePointFileVersionRecord): void => {
    const rows = versions_by_file.get(file_id);
    if (rows) rows.push(record);
    else versions_by_file.set(file_id, [record]);
  };
  for (const entry of entries.filter(records_file_content)) {
    add(entry.file_id, {
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
  for (const [file_id, rows] of collected_rows) {
    for (const row of rows) add(file_id, row);
  }
  return [...versions_by_file.entries()].map(([file_id, versions]) => ({
    file_id,
    site_id,
    versions,
  }));
}

/**
 * Saves snapshot manifest, the run's single version index object, and the delta cursor. Each
 * write is preceded by a lease check, so a run that lost its site commits nothing (issue #623).
 */
export async function persist_snapshot_backup(
  manifests: SharePointManifestRepository,
  file_indexes: SharePointFileVersionIndexRepository,
  cursors: SharePointDeltaCursorRepository,
  ctx: TenantContext,
  lease: HeldOwnerLease,
  site_id: string,
  snapshot: SharePointSnapshotManifest,
  entries: SharePointManifestEntry[],
  cursor: SharePointDeltaCursor,
  collected_rows: Map<string, SharePointFileVersionRecord[]>,
): Promise<void> {
  lease.assert_held();
  await manifests.save(ctx, snapshot, lease);
  await file_indexes.write_run_index(
    ctx,
    site_id,
    snapshot.snapshot_id,
    build_run_version_indexes(site_id, snapshot.snapshot_id, entries, collected_rows),
  );
  lease.assert_held();
  await cursors.save(ctx, cursor);
}
