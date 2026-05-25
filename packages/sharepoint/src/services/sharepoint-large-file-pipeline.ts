import { createHash } from 'node:crypto';
import { logger } from '@atlas/core/utils/logger';
import type {
  MultipartUploadHandle,
  SharePointSiteConnector,
  SharePointDeltaItem,
  StorageObjectLockPolicy,
  TenantContext,
} from '@atlas/types';
import { fetch_file_chunks } from '@/services/sharepoint-large-file-chunk-download';
import {
  flush_pending_parts,
  PART_SIZE,
  safe_abort_multipart,
} from '@/services/sharepoint-large-file-upload';
import {
  sharepoint_data_key,
  sharepoint_staging_key,
  sharepoint_staging_prefix,
} from '@/services/sharepoint-storage-keys';

/** Files at or above this size use the chunked staging + multipart pipeline. */
export const LARGE_FILE_THRESHOLD = 512 * 1024 * 1024;

export interface LargeFileResult {
  readonly checksum: string;
  readonly storage_key: string;
  readonly stored: boolean;
  readonly deduplicated: boolean;
}

interface StreamUploadResult {
  readonly checksum: string;
  readonly handle: MultipartUploadHandle;
  readonly completed_parts: Array<{ ETag: string; PartNumber: number }>;
}

/**
 * Single-download, zero-disk pipeline for files >= 512 MiB.
 * Streams encrypted parts to an S3 staging key, then either aborts
 * (dedup) or copies to the canonical content-addressed key.
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

  const { checksum, handle, completed_parts } = await stream_encrypt_upload(
    download_url,
    item,
    staging_key,
    ctx,
  );

  const canonical_key = sharepoint_data_key(site_id, checksum);
  const exists = await ctx.storage.exists(canonical_key);

  if (exists) {
    await safe_abort_multipart(handle, sharepoint_staging_prefix(site_id), ctx);
    logger.info(`Deduplicated ${item.file_name} (already stored)`);
    return { checksum, storage_key: canonical_key, stored: false, deduplicated: true };
  }

  await handle.complete(completed_parts);

  try {
    await ctx.storage.copy(staging_key, canonical_key, undefined, object_lock_policy);
  } catch (err) {
    if (is_precondition_failed(err)) {
      logger.info(`Concurrent writer stored ${item.file_name} first — dedup`);
      await ctx.storage.delete(staging_key).catch(() => {});
      return { checksum, storage_key: canonical_key, stored: false, deduplicated: true };
    }
    logger.warn(`Copy staging->canonical failed, cleaning up: ${err}`);
    await ctx.storage.delete(staging_key).catch(() => {});
    throw err;
  }

  await ctx.storage.delete(staging_key).catch(() => {});

  logger.info(`Stored ${item.file_name} (${format_bytes(item.size_bytes)})`);
  return { checksum, storage_key: canonical_key, stored: true, deduplicated: false };
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

async function stream_encrypt_upload(
  download_url: string,
  item: SharePointDeltaItem,
  staging_key: string,
  ctx: TenantContext,
): Promise<StreamUploadResult> {
  const { cipher, iv } = ctx.create_cipher();
  const hash = createHash('sha256');
  const handle = await ctx.storage.begin_multipart_upload(staging_key);

  try {
    const completed_parts: Array<{ ETag: string; PartNumber: number }> = [];
    let part_number = 2;
    const pending: Buffer[] = [];
    let pending_bytes = 0;
    let first_part_data: Buffer | null = null;

    for await (const chunk of fetch_file_chunks(download_url, item.size_bytes, item.item_id)) {
      hash.update(chunk);
      const encrypted = cipher.update(chunk);
      if (encrypted.length === 0) continue;

      pending.push(encrypted);
      pending_bytes += encrypted.length;

      while (pending_bytes >= PART_SIZE) {
        const flush_result = await flush_pending_parts(
          pending,
          pending_bytes,
          first_part_data,
          part_number,
          completed_parts,
          handle,
        );
        pending.length = 0;
        pending.push(...flush_result.pending);
        pending_bytes = flush_result.pending_bytes;
        first_part_data = flush_result.first_part_data;
        part_number = flush_result.part_number;
      }
    }

    const final_block = cipher.final();
    if (final_block.length > 0) {
      pending.push(final_block);
      pending_bytes += final_block.length;
    }

    if (!first_part_data) {
      first_part_data = Buffer.concat(pending);
      pending.length = 0;
      pending_bytes = 0;
    }

    if (pending_bytes > 0) {
      const last_part = Buffer.concat(pending);
      const etag = await handle.upload_part(part_number, last_part);
      completed_parts.push({ ETag: etag, PartNumber: part_number });
    }

    const auth_tag = cipher.getAuthTag();
    const header_part = Buffer.concat([iv, auth_tag, first_part_data]);
    const part1_etag = await handle.upload_part(1, header_part);
    completed_parts.push({ ETag: part1_etag, PartNumber: 1 });

    completed_parts.sort((a, b) => a.PartNumber - b.PartNumber);

    return { checksum: hash.digest('hex'), handle, completed_parts };
  } catch (err) {
    await safe_abort_multipart(
      handle,
      staging_key.substring(0, staging_key.lastIndexOf('/') + 1),
      ctx,
    );
    throw err;
  }
}

function is_precondition_failed(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>).Code ?? (err as Record<string, unknown>).code;
  if (code === 'PreconditionFailed') return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('PreconditionFailed') || message.includes('412');
}

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
