import { logger } from '@wisecom/atlas-core/utils/logger';
import { stream_to_content_addressed_storage } from '@wisecom/atlas-core/services/shared/stream-encrypt-upload';
import type { StorageObjectLockPolicy, TenantContext } from '@wisecom/atlas-types';
import type { DriveDeltaItem } from '@/drive-ports';
import { format_bytes } from '@/shared/format-bytes';
import type { DriveStorageKeys } from '@/shared/storage-keys';

export interface LargeFileResult {
  readonly checksum: string;
  readonly storage_key: string;
  readonly stored: boolean;
  readonly deduplicated: boolean;
}

/** Resolves the short-lived download URL for an item whose delta page did not carry one. */
export interface DriveDownloadUrlResolver {
  resolve_download_url(item: DriveDeltaItem): Promise<string | undefined>;
}

/**
 * What a provider supplies to the shared large-file pipeline: its key layout and its chunk
 * fetcher. The two providers reach for different chunked-download adapters, which is the only
 * behavioural difference between the copies this replaces.
 */
export interface DriveLargeFileDeps {
  readonly keys: DriveStorageKeys;
  readonly fetch_chunks: (
    download_url: string,
    total_bytes: number,
    item_id: string,
  ) => AsyncIterable<Buffer>;
}

/**
 * Single-download, zero-disk pipeline for files at or above the large-file threshold. Streams
 * encrypted parts to an S3 staging key, then either aborts (dedup) or copies to the canonical
 * content-addressed key.
 */
export async function process_large_drive_file(
  deps: DriveLargeFileDeps,
  connector: DriveDownloadUrlResolver,
  item: DriveDeltaItem,
  owner_id: string,
  ctx: TenantContext,
  object_lock_policy?: StorageObjectLockPolicy,
): Promise<LargeFileResult> {
  const download_url = item.download_url ?? (await connector.resolve_download_url(item));
  if (!download_url) {
    throw new Error(`Could not resolve download URL for large file ${item.item_id}`);
  }

  const staging_key = deps.keys.staging_key(owner_id, item.item_id);

  logger.info(
    `Streaming large file ${item.file_name} (${format_bytes(item.size_bytes)}) via staging key...`,
  );

  const result = await stream_to_content_addressed_storage(
    ctx,
    deps.fetch_chunks(download_url, item.size_bytes, item.item_id),
    {
      staging_key,
      staging_prefix: deps.keys.staging_prefix_for(owner_id),
      build_data_key: (checksum) => deps.keys.data_key(owner_id, checksum),
      ...(object_lock_policy && { object_lock_policy }),
    },
  );

  if (result.deduplicated) {
    logger.info(`Deduplicated ${item.file_name} (already stored)`);
  } else {
    logger.info(`Stored ${item.file_name} (${format_bytes(item.size_bytes)})`);
  }

  return result;
}

/** Removes leftover staging objects and incomplete multipart uploads. */
export async function cleanup_stale_drive_staging(
  keys: DriveStorageKeys,
  ctx: TenantContext,
  owner_id: string,
): Promise<void> {
  const prefix = keys.staging_prefix_for(owner_id);

  const stale_keys = await ctx.storage.list(prefix);
  for (const key of stale_keys) {
    logger.info(`Cleaning up stale staging object: ${key}`);
    await ctx.storage.delete(key).catch(() => {});
  }

  const aborted = await ctx.storage.abort_incomplete_uploads(prefix);
  if (aborted > 0) {
    logger.info(`Aborted ${aborted} incomplete staging upload(s)`);
  }
}
