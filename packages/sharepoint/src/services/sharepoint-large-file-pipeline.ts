import { logger } from '@wisecom/atlas-core/utils/logger';
import { stream_to_content_addressed_storage } from '@wisecom/atlas-core/services/shared/stream-encrypt-upload';
import type {
  SharePointSiteConnector,
  SharePointDeltaItem,
  StorageObjectLockPolicy,
  TenantContext,
} from '@wisecom/atlas-types';
import { fetch_file_chunks } from '@/services/sharepoint-large-file-chunk-download';
import {
  sharepoint_data_key,
  sharepoint_staging_key,
  sharepoint_staging_prefix,
} from '@/services/sharepoint-storage-keys';

/**
 * Files at or above this size use the chunked staging + multipart pipeline.
 *
 * The buffered path below this holds the plaintext and its ciphertext copy at
 * once, so the threshold is the per-file memory ceiling doubled. 64 MB keeps
 * document- and photo-sized content on the single-PUT path while capping that
 * ceiling at ~128 MB; the streaming path costs a staging copy per file, which
 * is why this is not lower still.
 */
export const LARGE_FILE_THRESHOLD = 64 * 1024 * 1024;

export interface LargeFileResult {
  readonly checksum: string;
  readonly storage_key: string;
  readonly stored: boolean;
  readonly deduplicated: boolean;
}

/**
 * Single-download, zero-disk pipeline for files at or above
 * {@link LARGE_FILE_THRESHOLD}. Streams encrypted parts to an S3 staging key,
 * then either aborts (dedup) or copies to the canonical content-addressed key.
 */
export async function process_large_file(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  ctx: TenantContext,
  object_lock_policy?: StorageObjectLockPolicy,
): Promise<LargeFileResult> {
  const download_url = item.download_url ?? (await connector.resolve_download_url(item));
  if (!download_url) {
    throw new Error(`Could not resolve download URL for large file ${item.item_id}`);
  }

  const staging_key = sharepoint_staging_key(site_id, item.item_id);

  logger.info(
    `Streaming large file ${item.file_name} (${format_bytes(item.size_bytes)}) via staging key...`,
  );

  const result = await stream_to_content_addressed_storage(
    ctx,
    fetch_file_chunks(download_url, item.size_bytes, item.item_id),
    {
      staging_key,
      staging_prefix: sharepoint_staging_prefix(site_id),
      build_data_key: (checksum) => sharepoint_data_key(site_id, checksum),
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
export async function cleanup_stale_staging(ctx: TenantContext, site_id: string): Promise<void> {
  const prefix = sharepoint_staging_prefix(site_id);

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

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
