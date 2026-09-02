/**
 * The drive behaviour OneDrive and SharePoint share, taking each provider's values as arguments.
 *
 * The modules that still exist twice in the provider packages fall into two groups (#306). The
 * ones with real differences carry a comment saying so and what the difference is:
 * `backup.service.ts`, `restore.service.ts`, `status.service.ts`, `backup-builders.ts` and
 * `restore-folder-path.ts`. Everything else that still pairs up by name is a binder: a class that
 * satisfies a per-provider port, a descriptor that names the manifest lookup, or a module that
 * supplies the key layout and a chunk fetcher to the shared code below. Those exist precisely to
 * hold the provider's values, so deduplicating them would mean giving up the separate ports, and
 * a near-zero diff there is the intended result rather than duplication left behind.
 */
export * from '@/drive-ports';
export { download_with_retry, type DownloadRetryOptions } from '@/backup/download-retry';
export { classify_drive_change } from '@/backup/change-classifier';
export { process_drive_backup_file, type FileProcessResult } from '@/backup/file-processor';
export {
  process_large_drive_file,
  cleanup_stale_drive_staging,
  type DriveDownloadUrlResolver,
  type DriveLargeFileDeps,
  type LargeFileResult,
} from '@/backup/large-file-pipeline';
export { format_bytes } from '@/shared/format-bytes';
export { LARGE_FILE_THRESHOLD } from '@/backup/large-file-threshold';
export {
  stream_whole_file_in_chunks,
  type WholeFileStreamOptions,
} from '@/backup/whole-file-stream';
export {
  should_stream_restore,
  verify_streaming_checksum,
  stream_decrypt_from_storage,
  type StreamDecryptResult,
} from '@/restore/streaming-restore';
export { filter_drive_entries } from '@/shared/entry-filter';
export { join_drive_path } from '@/shared/logical-path';
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
export { ensure_drive_folder_path, type DriveFolderCreator } from '@/restore/folder-path';
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
