import { build_drive_storage_keys } from '@wisecom/atlas-drive/shared/storage-keys';

/** SharePoint's key layout, for shared drive code that takes the whole layout as one argument. */
export const SHAREPOINT_KEYS = build_drive_storage_keys('sharepoint', (value) =>
  // A URL here means a caller skipped site resolution (issue #90); say so
  // instead of blaming the key, which sends the operator to the wrong layer.
  /^https?:\/\//i.test(value)
    ? ' -- expected a resolved SharePoint site id (hostname,siteGuid,webGuid), got a URL'
    : '',
);
const keys = SHAREPOINT_KEYS;

/** Prefix for content-addressed SharePoint file blobs. */
export const SHAREPOINT_DATA_PREFIX = keys.data_prefix;

/** Prefix for multipart staging objects before deduplication copy. */
export const SHAREPOINT_STAGING_PREFIX = keys.staging_prefix;

/** Prefix for snapshot manifest JSON objects. */
export const SHAREPOINT_MANIFEST_PREFIX = keys.manifest_prefix;

/** Prefix for version index objects (one per backup run, plus legacy per-file objects). */
export const SHAREPOINT_INDEX_PREFIX = keys.index_prefix;

/** Prefix for SharePoint sync metadata (e.g. delta cursors). */
export const SHAREPOINT_META_PREFIX = keys.meta_prefix;

/** Ensures a single path segment is safe for S3-style keys (no traversal or extra slashes). */
export const validate_key_segment = keys.validate_key_segment;

/** Builds the content-addressed key for a stored file blob. */
export const sharepoint_data_key = keys.data_key;

/** Builds the key for a snapshot manifest. */
export const sharepoint_manifest_key = keys.manifest_key;

/** Builds the prefix for listing all manifests of a site. */
export const sharepoint_manifest_prefix = keys.manifest_prefix_for;

/** Returns the root prefix for all SharePoint manifests. */
export const sharepoint_manifest_root_prefix = keys.manifest_root_prefix;

/** Builds the key for one backup run's version index object (issue #161). */
export const sharepoint_run_index_key = keys.run_index_key;

/** Prefix listing every version index object of a site, per-run and legacy per-file alike. */
export const sharepoint_index_prefix = keys.index_prefix_for;

/** Returns the root prefix for all SharePoint version index objects. */
export const sharepoint_index_root_prefix = keys.index_root_prefix;

/** Builds a unique staging key for multipart upload of a file. */
export const sharepoint_staging_key = keys.staging_key;

/** Builds the prefix for listing staging objects. */
export const sharepoint_staging_prefix = keys.staging_prefix_for;

/** Builds the key for the delta cursor state. */
export const sharepoint_delta_cursor_key = keys.delta_cursor_key;
