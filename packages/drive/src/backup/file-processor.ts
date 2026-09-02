import { createHash } from 'node:crypto';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { is_unretryable_download_failure } from '@wisecom/atlas-m365-graph';
import type { TenantContext } from '@wisecom/atlas-types';
import { download_with_retry } from '@/backup/download-retry';
import { LARGE_FILE_THRESHOLD } from '@/backup/large-file-threshold';
import {
  process_large_drive_file,
  type DriveDownloadUrlResolver,
  type DriveLargeFileDeps,
} from '@/backup/large-file-pipeline';
import type { DriveContentConnector, DriveDeltaItem } from '@/drive-ports';

const HASH_CHUNK_SIZE = 64 * 1024 * 1024;

export interface FileProcessResult {
  storage_key: string;
  checksum: string;
  stored: boolean;
  deduplicated: boolean;
}

/** Downloads or deduplicates a single delta file item. */
export async function process_drive_backup_file(
  deps: DriveLargeFileDeps,
  connector: DriveContentConnector & DriveDownloadUrlResolver,
  item: DriveDeltaItem,
  owner_id: string,
  ctx: TenantContext,
): Promise<FileProcessResult | undefined> {
  if (item.size_bytes >= LARGE_FILE_THRESHOLD) {
    try {
      return await process_large_drive_file(deps, connector, item, owner_id, ctx);
    } catch (err) {
      // A missing grant or a service refusal is not a skip: it must reach the caller
      // so the run can name the cause instead of reporting a lost file (issue #246).
      if (is_unretryable_download_failure(err)) throw err;
      logger.warn(
        `Skipping large file ${item.item_id} (${item.file_name}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  const raw_body = await download_with_retry(connector, item);
  if (!raw_body) return undefined;

  const checksum = compute_sha256_chunked(raw_body);
  const storage_key = deps.keys.data_key(owner_id, checksum);
  const exists = await ctx.storage.exists(storage_key);

  if (!exists) {
    await ctx.storage.put(storage_key, ctx.encrypt(raw_body));
    return { storage_key, checksum, stored: true, deduplicated: false };
  }

  return { storage_key, checksum, stored: false, deduplicated: true };
}

/** Computes SHA-256 in chunks to avoid ERR_OUT_OF_RANGE on buffers > 2 GB. */
function compute_sha256_chunked(data: Buffer): string {
  const hash = createHash('sha256');
  for (let offset = 0; offset < data.length; offset += HASH_CHUNK_SIZE) {
    hash.update(data.subarray(offset, Math.min(offset + HASH_CHUNK_SIZE, data.length)));
  }
  return hash.digest('hex');
}
