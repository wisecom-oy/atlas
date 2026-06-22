import { createHash } from 'node:crypto';
import { fetch_file_chunks } from '@/adapters/graph-onedrive-chunked-download';
import {
  onedrive_data_key,
  onedrive_staging_key,
  onedrive_staging_prefix,
} from '@/services/onedrive-storage-keys';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  MultipartUploadHandle,
  OneDriveConnector,
  OneDriveDeltaItem,
  StorageObjectLockPolicy,
  TenantContext,
} from '@wisecom/atlas-types';

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

interface PendingPartState {
  pending: Buffer[];
  pending_bytes: number;
  first_part_data: Buffer | null;
  part_number: number;
  completed_parts: Array<{ ETag: string; PartNumber: number }>;
}

/** Splits pending encrypted bytes into a full multipart upload part. */
async function flush_pending_parts(
  handle: MultipartUploadHandle,
  state: PendingPartState,
): Promise<void> {
  const combined = Buffer.concat(state.pending);
  state.pending.length = 0;
  state.pending_bytes = 0;

  const part_data = combined.subarray(0, PART_SIZE);
  if (combined.length > PART_SIZE) {
    const remainder = Buffer.from(combined.subarray(PART_SIZE));
    state.pending.push(remainder);
    state.pending_bytes = remainder.length;
  }

  if (!state.first_part_data) {
    state.first_part_data = Buffer.from(part_data);
  } else {
    const etag = await handle.upload_part(state.part_number, Buffer.from(part_data));
    state.completed_parts.push({ ETag: etag, PartNumber: state.part_number });
    state.part_number++;
  }
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
    await safe_abort(handle, onedrive_staging_prefix(owner_id), ctx);
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
  const handle = await ctx.storage.begin_multipart_upload(staging_key);

  try {
    const part_state: PendingPartState = {
      pending: [],
      pending_bytes: 0,
      first_part_data: null,
      part_number: 2,
      completed_parts: [],
    };

    for await (const chunk of fetch_file_chunks(download_url, item.size_bytes, item.item_id)) {
      hash.update(chunk);
      const encrypted = cipher.update(chunk);
      if (encrypted.length === 0) continue;

      part_state.pending.push(encrypted);
      part_state.pending_bytes += encrypted.length;

      while (part_state.pending_bytes >= PART_SIZE) {
        await flush_pending_parts(handle, part_state);
      }
    }

    const final_block = cipher.final();
    if (final_block.length > 0) {
      part_state.pending.push(final_block);
      part_state.pending_bytes += final_block.length;
    }

    if (!part_state.first_part_data) {
      part_state.first_part_data = Buffer.concat(part_state.pending);
      part_state.pending.length = 0;
      part_state.pending_bytes = 0;
    }

    if (part_state.pending_bytes > 0) {
      const last_part = Buffer.concat(part_state.pending);
      const etag = await handle.upload_part(part_state.part_number, last_part);
      part_state.completed_parts.push({ ETag: etag, PartNumber: part_state.part_number });
    }

    const auth_tag = cipher.getAuthTag();
    const header_part = Buffer.concat([iv, auth_tag, part_state.first_part_data]);
    const part1_etag = await handle.upload_part(1, header_part);
    part_state.completed_parts.push({ ETag: part1_etag, PartNumber: 1 });

    part_state.completed_parts.sort((a, b) => a.PartNumber - b.PartNumber);

    return { checksum: hash.digest('hex'), handle, completed_parts: part_state.completed_parts };
  } catch (err) {
    await safe_abort(handle, staging_key.substring(0, staging_key.lastIndexOf('/') + 1), ctx);
    throw err;
  }
}

async function safe_abort(
  handle: MultipartUploadHandle,
  staging_prefix: string,
  ctx: TenantContext,
): Promise<void> {
  try {
    await handle.abort();
  } catch (err) {
    logger.warn(`Multipart abort failed, cleaning up orphaned parts: ${err}`);
    await ctx.storage.abort_incomplete_uploads(staging_prefix).catch(() => {});
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
