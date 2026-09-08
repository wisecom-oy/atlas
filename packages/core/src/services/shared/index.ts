export * from '@/services/shared/owner-id-migration';
export {
  create_file_archive,
  add_file_to_archive,
  finalize_file_archive,
} from '@/services/shared/file-save-zip-writer';
export type { ArchiveTarget, FileArchive } from '@/services/shared/file-save-zip-writer';
export { resolve_save_target } from '@/services/shared/save-archive-target';
export type { ResolvedSaveTarget, SaveTargetOptions } from '@/services/shared/save-archive-target';
export {
  filter_manifests_by_date,
  merge_snapshot_entries,
} from '@/services/shared/manifest-entry-merger';
export {
  fold_drive_snapshot_chain,
  select_drive_manifest_chain,
} from '@/services/shared/drive-snapshot-chain';
export type { DriveChainEntry, DriveChainManifest } from '@/services/shared/drive-snapshot-chain';
export { stream_decrypt_from_storage } from '@/services/shared/stream-decrypt';
export type { StreamDecryptResult } from '@/services/shared/stream-decrypt';
export {
  assert_restored_content_matches,
  RestoredContentMismatchError,
} from '@/services/shared/restored-content-verifier';
export { is_absent_object_error } from '@/services/shared/absent-object';
export {
  safe_abort_multipart,
  stream_encrypt_to_multipart,
  stream_to_content_addressed_storage,
} from '@/services/shared/stream-encrypt-upload';
export type {
  CompletedPart,
  ContentAddressedStreamResult,
  ContentAddressedStreamTarget,
  StreamEncryptUploadResult,
} from '@/services/shared/stream-encrypt-upload';
export {
  build_object_lock_policy,
  build_object_lock_request,
  compute_retain_until_utc,
  parse_object_lock_mode,
} from '@/services/shared/object-lock-policy';
export type { ObjectLockSettings } from '@/services/shared/object-lock-policy';
