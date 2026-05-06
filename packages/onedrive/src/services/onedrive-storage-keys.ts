import { randomBytes } from 'node:crypto';

/** Prefix for content-addressed OneDrive file blobs. */
export const ONEDRIVE_DATA_PREFIX = 'onedrive/data';

/** Prefix for multipart staging objects before deduplication copy. */
export const ONEDRIVE_STAGING_PREFIX = 'onedrive/staging';

/** Prefix for snapshot manifest JSON objects. */
export const ONEDRIVE_MANIFEST_PREFIX = 'onedrive/manifests';

/** Prefix for per-file version index JSON objects. */
export const ONEDRIVE_INDEX_PREFIX = 'onedrive/index';

/** Prefix for OneDrive sync metadata (e.g. delta cursors). */
export const ONEDRIVE_META_PREFIX = 'onedrive/_meta';

/** Builds the content-addressed key for a stored file blob. */
export function onedrive_data_key(owner_id: string, checksum: string): string {
  return `${ONEDRIVE_DATA_PREFIX}/${owner_id}/${checksum}`;
}

/** Builds the key for a snapshot manifest. */
export function onedrive_manifest_key(owner_id: string, snapshot_id: string): string {
  return `${ONEDRIVE_MANIFEST_PREFIX}/${owner_id}/${snapshot_id}.json`;
}

/** Builds the prefix for listing all manifests of an owner. */
export function onedrive_manifest_prefix(owner_id: string): string {
  return `${ONEDRIVE_MANIFEST_PREFIX}/${owner_id}/`;
}

/** Returns the root prefix for all OneDrive manifests. */
export function onedrive_manifest_root_prefix(): string {
  return `${ONEDRIVE_MANIFEST_PREFIX}/`;
}

/** Builds the key for a file's version index. */
export function onedrive_index_key(owner_id: string, file_id: string): string {
  return `${ONEDRIVE_INDEX_PREFIX}/${owner_id}/files/${file_id}.json`;
}

/** Builds the prefix for listing all file indexes of an owner. */
export function onedrive_index_prefix(owner_id: string): string {
  return `${ONEDRIVE_INDEX_PREFIX}/${owner_id}/files/`;
}

/** Returns the root prefix for all OneDrive file indexes. */
export function onedrive_index_root_prefix(): string {
  return `${ONEDRIVE_INDEX_PREFIX}/`;
}

/** Builds a unique staging key for multipart upload of a file. */
export function onedrive_staging_key(owner_id: string, item_id: string): string {
  const suffix = randomBytes(4).toString('hex');
  return `${ONEDRIVE_STAGING_PREFIX}/${owner_id}/${item_id}-${suffix}`;
}

/** Builds the prefix for listing staging objects. */
export function onedrive_staging_prefix(owner_id: string): string {
  return `${ONEDRIVE_STAGING_PREFIX}/${owner_id}/`;
}

/** Builds the key for the delta cursor state. */
export function onedrive_delta_cursor_key(owner_id: string): string {
  return `${ONEDRIVE_META_PREFIX}/${owner_id}/delta.json`;
}
