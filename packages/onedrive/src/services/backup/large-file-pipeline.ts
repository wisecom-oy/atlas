import type { StorageObjectLockPolicy, TenantContext } from '@wisecom/atlas-types';
import type { OneDriveConnector, OneDriveDeltaItem } from '@wisecom/atlas-types';
import {
  cleanup_stale_drive_staging,
  process_large_drive_file,
  type DriveLargeFileDeps,
  type LargeFileResult,
} from '@wisecom/atlas-drive/backup/large-file-pipeline';
import { fetch_file_chunks } from '@/adapters/graph-onedrive-chunked-download';
import { ONEDRIVE_KEYS } from '@/services/shared/storage-keys';

export { LARGE_FILE_THRESHOLD } from '@wisecom/atlas-drive/backup/large-file-threshold';
export type { LargeFileResult } from '@wisecom/atlas-drive/backup/large-file-pipeline';

/** OneDrive's half of the shared large-file pipeline: its key layout and its chunk fetcher. */
export const ONEDRIVE_LARGE_FILE_DEPS: DriveLargeFileDeps = {
  keys: ONEDRIVE_KEYS,
  fetch_chunks: fetch_file_chunks,
};

/** Streams a large file to storage through a staging key, deduplicating by content hash. */
export async function process_large_file(
  connector: OneDriveConnector,
  item: OneDriveDeltaItem,
  owner_id: string,
  ctx: TenantContext,
  object_lock_policy?: StorageObjectLockPolicy,
): Promise<LargeFileResult> {
  return process_large_drive_file(
    ONEDRIVE_LARGE_FILE_DEPS,
    connector,
    item,
    owner_id,
    ctx,
    object_lock_policy,
  );
}

/** Removes leftover staging objects and incomplete multipart uploads. */
export async function cleanup_stale_staging(ctx: TenantContext, owner_id: string): Promise<void> {
  return cleanup_stale_drive_staging(ONEDRIVE_KEYS, ctx, owner_id);
}
