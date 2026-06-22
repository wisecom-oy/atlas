import { logger } from '@atlas/core/utils/logger';
import type { MultipartUploadHandle, TenantContext } from '@atlas/types';

export const PART_SIZE = 8 * 1024 * 1024;

interface FlushPendingResult {
  pending: Buffer[];
  pending_bytes: number;
  first_part_data: Buffer | null;
  part_number: number;
}

/** Splits buffered encrypted data into a full multipart part and any remainder. */
export async function flush_pending_parts(
  pending: Buffer[],
  pending_bytes: number,
  first_part_data: Buffer | null,
  part_number: number,
  completed_parts: Array<{ ETag: string; PartNumber: number }>,
  handle: MultipartUploadHandle,
): Promise<FlushPendingResult> {
  const combined = Buffer.concat(pending);
  const part_data = combined.subarray(0, PART_SIZE);
  const remainder =
    combined.length > PART_SIZE ? Buffer.from(combined.subarray(PART_SIZE)) : Buffer.alloc(0);

  if (!first_part_data) {
    return {
      pending: remainder.length > 0 ? [remainder] : [],
      pending_bytes: remainder.length,
      first_part_data: Buffer.from(part_data),
      part_number,
    };
  }

  const etag = await handle.upload_part(part_number, Buffer.from(part_data));
  completed_parts.push({ ETag: etag, PartNumber: part_number });

  return {
    pending: remainder.length > 0 ? [remainder] : [],
    pending_bytes: remainder.length,
    first_part_data,
    part_number: part_number + 1,
  };
}

/** Aborts a multipart upload and cleans up orphaned staging parts on failure. */
export async function safe_abort_multipart(
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
