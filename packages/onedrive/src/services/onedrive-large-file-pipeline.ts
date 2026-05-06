import { createHash } from 'node:crypto';
import { fetch_file_chunks } from '@/adapters/graph-onedrive-chunk-fetcher';
import {
  onedrive_data_key,
  onedrive_staging_key,
  onedrive_staging_prefix,
} from '@/services/onedrive-storage-keys';
import { logger } from '@atlas/core/utils/logger';
import type {
  MultipartUploadHandle,
  OneDriveConnector,
  OneDriveDeltaItem,
  StorageObjectLockPolicy,
  TenantContext,
} from '@atlas/types';

/** Files at or above this size use the chunked staging + multipart pipeline. */
export const LARGE_FILE_THRESHOLD = 512 * 1024 * 1024;

const PART_SIZE = 8 * 1024 * 1024;

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
 * Single-download, zero-disk pipeline for files >= 512 MB.
 * Streams encrypted parts to an S3 staging key, then either aborts
 * (dedup) or copies to the canonical content-addressed key.
 */
export async function process_large_file(
  connector: OneDriveConnector,
  item: OneDriveDeltaItem,
  owner_id: string,
  ctx: TenantContext,
  object_lock_policy?: StorageObjectLockPolicy,
): Promise<LargeFileResult> {
  const download_url = item.download_url ?? (await connector.resolve_download_url(item));
  if (!download_url) {
    throw new Error(`Could not resolve download URL for large file ${item.item_id}`);
  }

  const staging_key = onedrive_staging_key(owner_id, item.item_id);

  logger.info(
    `Streaming large file ${item.file_name} (${format_bytes(item.size_bytes)}) via staging key...`,
  );

  const { checksum, handle, completed_parts } = await stream_encrypt_upload(
    download_url,
    item,
    staging_key,
    ctx,
  );

  const canonical_key = onedrive_data_key(owner_id, checksum);
  const exists = await ctx.storage.exists(canonical_key);

  if (exists) {
    await handle.abort();
    logger.info(`Deduplicated ${item.file_name} (already stored)`);
    return { checksum, storage_key: canonical_key, stored: false, deduplicated: true };
  }

  await handle.complete(completed_parts);

  const metadata = {
    'x-onedrive-file-id': item.item_id,
    'x-plaintext-sha256': checksum,
  };

  try {
    await ctx.storage.copy(staging_key, canonical_key, metadata, object_lock_policy);
  } catch (err) {
    logger.warn(`Copy staging->canonical failed, cleaning up: ${err}`);
    await ctx.storage.delete(staging_key).catch(() => {});
    throw err;
  }

  await ctx.storage.delete(staging_key).catch(() => {});

  logger.info(`Stored ${item.file_name} (${format_bytes(item.size_bytes)})`);
  return { checksum, storage_key: canonical_key, stored: true, deduplicated: false };
}

/** Removes leftover staging objects and incomplete multipart uploads. */
export async function cleanup_stale_staging(ctx: TenantContext, owner_id: string): Promise<void> {
  const prefix = onedrive_staging_prefix(owner_id);

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
  item: OneDriveDeltaItem,
  staging_key: string,
  ctx: TenantContext,
): Promise<StreamUploadResult> {
  const { cipher, iv } = ctx.create_cipher();
  const hash = createHash('sha256');
  const handle = await ctx.storage.begin_multipart_upload(staging_key, {
    'x-onedrive-file-id': item.item_id,
  });

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
        const combined = Buffer.concat(pending);
        pending.length = 0;
        pending_bytes = 0;

        const part_data = combined.subarray(0, PART_SIZE);
        if (combined.length > PART_SIZE) {
          const remainder = Buffer.from(combined.subarray(PART_SIZE));
          pending.push(remainder);
          pending_bytes = remainder.length;
        }

        if (!first_part_data) {
          first_part_data = Buffer.from(part_data);
        } else {
          const etag = await handle.upload_part(part_number, Buffer.from(part_data));
          completed_parts.push({ ETag: etag, PartNumber: part_number });
          part_number++;
        }
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
    await handle.abort();
    throw err;
  }
}

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
