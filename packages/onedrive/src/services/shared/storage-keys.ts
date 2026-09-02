import { build_drive_storage_keys } from '@wisecom/atlas-drive/shared/storage-keys';

/** OneDrive's key layout, for shared drive code that takes the whole layout as one argument. */
export const ONEDRIVE_KEYS = build_drive_storage_keys('onedrive');
const keys = ONEDRIVE_KEYS;

/** Prefix for content-addressed OneDrive file blobs. */
export const ONEDRIVE_DATA_PREFIX = keys.data_prefix;

/** Prefix for multipart staging objects before deduplication copy. */
export const ONEDRIVE_STAGING_PREFIX = keys.staging_prefix;

/** Prefix for snapshot manifest JSON objects. */
export const ONEDRIVE_MANIFEST_PREFIX = keys.manifest_prefix;

/** Prefix for version index objects (one per backup run, plus legacy per-file objects). */
export const ONEDRIVE_INDEX_PREFIX = keys.index_prefix;

/** Prefix for OneDrive sync metadata (e.g. delta cursors). */
export const ONEDRIVE_META_PREFIX = keys.meta_prefix;

/** Ensures a single path segment is safe for S3-style keys (no traversal or extra slashes). */
export const validate_key_segment = keys.validate_key_segment;

/** Builds the content-addressed key for a stored file blob. */
export const onedrive_data_key = keys.data_key;

/** Builds the key for a snapshot manifest. */
export const onedrive_manifest_key = keys.manifest_key;

/** Builds the prefix for listing all manifests of an owner. */
export const onedrive_manifest_prefix = keys.manifest_prefix_for;

/** Returns the root prefix for all OneDrive manifests. */
export const onedrive_manifest_root_prefix = keys.manifest_root_prefix;

/** Builds the key for one backup run's version index object (issue #161). */
export const onedrive_run_index_key = keys.run_index_key;

/** Prefix listing every version index object of an owner, per-run and legacy per-file alike. */
export const onedrive_index_prefix = keys.index_prefix_for;

/** Returns the root prefix for all OneDrive version index objects. */
export const onedrive_index_root_prefix = keys.index_root_prefix;

/** Builds a unique staging key for multipart upload of a file. */
export const onedrive_staging_key = keys.staging_key;

/** Builds the prefix for listing staging objects. */
export const onedrive_staging_prefix = keys.staging_prefix_for;

/** Builds the key for the delta cursor state. */
export const onedrive_delta_cursor_key = keys.delta_cursor_key;
