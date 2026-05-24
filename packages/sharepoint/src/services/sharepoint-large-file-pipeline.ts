import { createHash } from 'node:crypto';
import { logger } from '@atlas/core/utils/logger';
import type {
  MultipartUploadHandle,
  SharePointSiteConnector,
  SharePointDeltaItem,
  StorageObjectLockPolicy,
  TenantContext,
} from '@atlas/types';
import {
  sharepoint_data_key,
  sharepoint_staging_key,
  sharepoint_staging_prefix,
} from '@/services/sharepoint-storage-keys';

/** Files at or above this size use the chunked staging + multipart pipeline. */
export const LARGE_FILE_THRESHOLD = 512 * 1024 * 1024;

const PART_SIZE = 8 * 1024 * 1024;
const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 5;
const CHUNK_BASE_DELAY_MS = 1_000;
const CHUNK_MAX_DELAY_MS = 30_000;
const MIN_THROUGHPUT_BYTES_PER_MS = 256;

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
    await safe_abort(handle, sharepoint_staging_prefix(site_id), ctx);
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
    await safe_abort(handle, staging_key.substring(0, staging_key.lastIndexOf('/') + 1), ctx);
    throw err;
  }
}

/** Async generator that yields 4 MiB buffers fetched via HTTP Range requests. */
async function* fetch_file_chunks(
  download_url: string,
  total_bytes: number,
  item_id: string,
): AsyncGenerator<Buffer> {
  const chunk_count = Math.ceil(total_bytes / CHUNK_SIZE_BYTES);

  for (let i = 0; i < chunk_count; i++) {
    const range_start = i * CHUNK_SIZE_BYTES;
    const range_end = Math.min(range_start + CHUNK_SIZE_BYTES - 1, total_bytes - 1);
    const expected_length = range_end - range_start + 1;

    yield await download_chunk_with_retry(
      download_url,
      range_start,
      range_end,
      expected_length,
      item_id,
      i + 1,
      chunk_count,
    );
  }
}

async function download_chunk_with_retry(
  url: string,
  range_start: number,
  range_end: number,
  expected_length: number,
  item_id: string,
  chunk_index: number,
  total_chunks: number,
): Promise<Buffer> {
  for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
    try {
      return await download_single_chunk(url, range_start, range_end, expected_length, item_id);
    } catch (err) {
      if (!is_cdn_retryable(err) || attempt === MAX_CHUNK_RETRIES) {
        throw new Error(
          `Failed chunk ${chunk_index}/${total_chunks} of ${item_id} ` +
            `after ${attempt + 1} attempts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const delay = compute_retry_delay(attempt);
      logger.debug(
        `Chunk ${chunk_index}/${total_chunks} retry ${attempt + 1}/${MAX_CHUNK_RETRIES} ` +
          `for ${item_id} in ${(delay / 1000).toFixed(1)}s`,
      );
      await sleep(delay);
    }
  }

  throw new Error('download_chunk_with_retry: unreachable');
}

async function download_single_chunk(
  url: string,
  range_start: number,
  range_end: number,
  expected_length: number,
  item_id: string,
): Promise<Buffer> {
  const timeout_ms = Math.max(30_000, Math.ceil(expected_length / MIN_THROUGHPUT_BYTES_PER_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);

  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=${range_start}-${range_end}` },
      signal: controller.signal,
    });

    if (response.status === 429 || response.status === 503 || response.status === 504) {
      throw new Error(
        `HTTP ${response.status} for chunk bytes=${range_start}-${range_end} of ${item_id}`,
      );
    }

    if (response.status !== 206 && response.status !== 200) {
      throw new Error(
        `HTTP ${response.status} for chunk bytes=${range_start}-${range_end} of ${item_id}`,
      );
    }

    const buf = Buffer.from(await response.arrayBuffer());

    if (response.status === 200) {
      logger.warn(
        `CDN returned HTTP 200 instead of 206 for Range request on ${item_id} — ` +
          `server ignored Range header, slicing ${buf.length} bytes to expected range`,
      );
      if (buf.length < range_end + 1) {
        throw new Error(
          `CDN returned 200 with ${buf.length} bytes but range_end is ${range_end} for ${item_id}`,
        );
      }
      return buf.subarray(range_start, range_end + 1);
    }

    return buf;
  } finally {
    clearTimeout(timer);
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

function is_cdn_retryable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('429') || message.includes('503') || message.includes('504');
}

function is_precondition_failed(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>).Code ?? (err as Record<string, unknown>).code;
  if (code === 'PreconditionFailed') return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('PreconditionFailed') || message.includes('412');
}

function compute_retry_delay(attempt: number): number {
  const base = CHUNK_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * CHUNK_BASE_DELAY_MS;
  return Math.min(base + jitter, CHUNK_MAX_DELAY_MS);
}

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
