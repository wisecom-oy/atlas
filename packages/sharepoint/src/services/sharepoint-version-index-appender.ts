import type {
  SharePointFileVersionIndexRepository,
  SharePointManifestEntry,
  TenantContext,
} from '@wisecom/atlas-types';

/** Appends one version-index row per manifest entry of a completed snapshot. */
export async function append_version_indexes(
  file_indexes: SharePointFileVersionIndexRepository,
  ctx: TenantContext,
  site_id: string,
  entries: SharePointManifestEntry[],
  snapshot_id: string,
): Promise<void> {
  for (const entry of entries) {
    await file_indexes.append_version(ctx, site_id, entry.file_id, {
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
