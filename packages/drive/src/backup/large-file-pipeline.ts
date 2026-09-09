import { logger } from '@wisecom/atlas-core/utils/logger';
import { stream_to_content_addressed_storage } from '@wisecom/atlas-core/services/shared/stream-encrypt-upload';
import type { StorageObjectLockPolicy, TenantContext } from '@wisecom/atlas-types';
import type { DriveDeltaItem } from '@/drive-ports';
import { assert_transferred_size } from '@/backup/download-integrity';
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
    abort_signal?: AbortSignal,
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
  abort_signal?: AbortSignal,
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
    counted_chunks(
      deps.fetch_chunks(download_url, item.size_bytes, item.item_id, abort_signal),
      item,
    ),
    {
      staging_key,
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

/**
 * Passes chunks straight through, then fails the item if they did not add up to its reported size.
 *
 * The last point where a truncated, duplicated or restarted transfer can still be caught: past it
 * the bytes have a checksum and an auth tag of their own, and nothing downstream knows how many
 * there should have been (issue #338). Throwing here aborts the staged multipart upload, so no
 * canonical object is promoted and no manifest entry is written.
 */
async function* counted_chunks(
  chunks: AsyncIterable<Buffer>,
  item: DriveDeltaItem,
): AsyncGenerator<Buffer> {
  let transferred = 0;
  for await (const chunk of chunks) {
    transferred += chunk.length;
    yield chunk;
  }
  assert_transferred_size(item.item_id, transferred, item.size_bytes);
}

/**
 * Age past which a staging object or an incomplete upload is treated as abandoned.
 *
 * Nothing caps one item's transfer at this, and it is not meant to: a 250 GB item on a throttled
 * link can run for many hours, so the storage sweep also refuses to abort an upload with a part
 * written since the cutoff. The day is the coarse filter, recent activity is the real answer, and
 * the bucket's own `AbortIncompleteMultipartUpload` rule collects whatever both miss.
 *
 * For staging objects there is no activity to read, so the age stands alone. One is live only
 * between the multipart completion and the copy onto the canonical key, which is a server-side
 * copy of one file rather than a transfer, so a day is orders of magnitude longer than the window.
 */
const STAGING_ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Removes staging objects and incomplete multipart uploads left behind by earlier runs.
 *
 * Only what is demonstrably abandoned: two backups of the same owner share one staging prefix, and
 * an unfiltered sweep deleted the object the other run was about to copy and aborted the upload it
 * was still streaming into, which failed that run with `NoSuchUpload` on its next part
 * (issue #345).
 */
export async function cleanup_stale_drive_staging(
  keys: DriveStorageKeys,
  ctx: TenantContext,
  owner_id: string,
): Promise<void> {
  const prefix = keys.staging_prefix_for(owner_id);
  const abandoned_before = new Date(Date.now() - STAGING_ABANDONED_AFTER_MS);

  const stale_keys = await ctx.storage.list_stale(prefix, abandoned_before);
  for (const key of stale_keys) {
    logger.info(`Cleaning up stale staging object: ${key}`);
    await ctx.storage.delete(key).catch(() => {});
  }

  const aborted = await ctx.storage.abort_incomplete_uploads(prefix, abandoned_before);
  if (aborted > 0) {
    logger.info(`Aborted ${aborted} incomplete staging upload(s) older than 24h`);
  }
}
