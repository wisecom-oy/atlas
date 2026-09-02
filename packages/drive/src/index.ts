export * from '@/drive-ports';
export { download_with_retry, type DownloadRetryOptions } from '@/backup/download-retry';
export { LARGE_FILE_THRESHOLD } from '@/backup/large-file-threshold';
export {
  should_stream_restore,
  verify_streaming_checksum,
  stream_decrypt_from_storage,
  type StreamDecryptResult,
} from '@/restore/streaming-restore';
export { filter_drive_entries } from '@/shared/entry-filter';
export {
  load_drive_chain_entries,
  restorable_entries,
  type DriveChainEntryRow,
  type DriveManifestLookup,
} from '@/shared/manifest-chain';
export {
  build_drive_storage_keys,
  type DriveStorageKeys,
  type InvalidSegmentHint,
} from '@/shared/storage-keys';
export { save_drive_snapshot, type DriveSaveDeps } from '@/save/save-snapshot';
export {
  verify_drive_snapshot,
  type DriveVerificationResult,
  type DriveVerifyDeps,
} from '@/verification/verify-snapshot';
export {
  list_drive_snapshots,
  list_drive_file_versions,
  type DriveCatalogDeps,
} from '@/catalog/catalog-queries';
export {
  restore_drive_version,
  type DriveUploadConnector,
  type DriveVersionRestoreDeps,
} from '@/restore/version-restore';
export {
  sync_file_versions,
  collect_run_versions,
  type RunVersionCollector,
  type VersionSyncOutcome,
  type VersionSyncResult,
} from '@/versioning/version-sync';
export {
  store_version_content,
  VersionDownloadError,
  type StoredVersionContent,
} from '@/versioning/version-content-store';
export { split_parent_path, build_restored_file_name } from '@/versioning/version-placement';
export { resolve_file_id, version_logical_path } from '@/versioning/version-reference';
export {
  select_versions_to_restore,
  type SelectedVersion,
  type VersionSelection,
} from '@/versioning/version-selection';
export {
  version_timestamp_ms,
  is_version_already_captured,
  later_watermark,
  by_version_age,
} from '@/versioning/version-watermark';
