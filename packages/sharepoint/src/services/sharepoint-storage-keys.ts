import { randomBytes } from 'node:crypto';

/** Prefix for content-addressed SharePoint file blobs. */
export const SHAREPOINT_DATA_PREFIX = 'sharepoint/data';

/** Prefix for multipart staging objects before deduplication copy. */
export const SHAREPOINT_STAGING_PREFIX = 'sharepoint/staging';

/** Prefix for snapshot manifest JSON objects. */
export const SHAREPOINT_MANIFEST_PREFIX = 'sharepoint/manifests';

/** Prefix for per-file version index JSON objects. */
export const SHAREPOINT_INDEX_PREFIX = 'sharepoint/index';

/** Prefix for SharePoint sync metadata (e.g. delta cursors). */
export const SHAREPOINT_META_PREFIX = 'sharepoint/_meta';

/** Ensures a single path segment is safe for S3-style keys (no traversal or extra slashes). */
export function validate_key_segment(value: string): void {
  if (value === '' || value === '.' || value === '..') {
    throw new Error(`Invalid storage key segment: ${JSON.stringify(value)}`);
  }
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 47 || ch === 92 || ch === 0) {
      throw new Error(`Invalid storage key segment: ${JSON.stringify(value)}`);
    }
  }
}

/** Builds the content-addressed key for a stored file blob. */
export function sharepoint_data_key(site_id: string, checksum: string): string {
  validate_key_segment(site_id);
  validate_key_segment(checksum);
  return `${SHAREPOINT_DATA_PREFIX}/${site_id}/${checksum}`;
}

/** Builds the key for a snapshot manifest. */
export function sharepoint_manifest_key(site_id: string, snapshot_id: string): string {
  validate_key_segment(site_id);
  validate_key_segment(snapshot_id);
  return `${SHAREPOINT_MANIFEST_PREFIX}/${site_id}/${snapshot_id}.json`;
}

/** Builds the prefix for listing all manifests of a site. */
export function sharepoint_manifest_prefix(site_id: string): string {
  validate_key_segment(site_id);
  return `${SHAREPOINT_MANIFEST_PREFIX}/${site_id}/`;
}

/** Returns the root prefix for all SharePoint manifests. */
export function sharepoint_manifest_root_prefix(): string {
  return `${SHAREPOINT_MANIFEST_PREFIX}/`;
}

/** Builds the key for a file's version index. */
export function sharepoint_index_key(site_id: string, file_id: string): string {
  validate_key_segment(site_id);
  validate_key_segment(file_id);
  return `${SHAREPOINT_INDEX_PREFIX}/${site_id}/files/${file_id}.json`;
}

/** Builds the prefix for listing all file indexes of a site. */
export function sharepoint_index_prefix(site_id: string): string {
  validate_key_segment(site_id);
  return `${SHAREPOINT_INDEX_PREFIX}/${site_id}/files/`;
}

/** Returns the root prefix for all SharePoint file indexes. */
export function sharepoint_index_root_prefix(): string {
  return `${SHAREPOINT_INDEX_PREFIX}/`;
}

/** Builds a unique staging key for multipart upload of a file. */
export function sharepoint_staging_key(site_id: string, item_id: string): string {
  validate_key_segment(site_id);
  validate_key_segment(item_id);
  const suffix = randomBytes(4).toString('hex');
  return `${SHAREPOINT_STAGING_PREFIX}/${site_id}/${item_id}-${suffix}`;
}

/** Builds the prefix for listing staging objects. */
export function sharepoint_staging_prefix(site_id: string): string {
  validate_key_segment(site_id);
  return `${SHAREPOINT_STAGING_PREFIX}/${site_id}/`;
}

/** Builds the key for the delta cursor state. */
export function sharepoint_delta_cursor_key(site_id: string): string {
  validate_key_segment(site_id);
  return `${SHAREPOINT_META_PREFIX}/${site_id}/delta.json`;
}
