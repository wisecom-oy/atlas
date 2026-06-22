import { createHash } from 'node:crypto';
import type { SharePointSiteConnector, SharePointDeltaItem, TenantContext } from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';
import { download_with_retry } from '@/services/sharepoint-download-orchestrator';
import {
  LARGE_FILE_THRESHOLD,
  process_large_file,
} from '@/services/sharepoint-large-file-pipeline';
import { sharepoint_data_key } from '@/services/sharepoint-storage-keys';

const HASH_CHUNK_SIZE = 64 * 1024 * 1024;

export interface FileProcessResult {
  storage_key: string;
  checksum: string;
  stored: boolean;
  deduplicated: boolean;
}

/** Downloads or deduplicates a single delta file item. */
export async function process_backup_file(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  ctx: TenantContext,
): Promise<FileProcessResult | undefined> {
  if (item.size_bytes >= LARGE_FILE_THRESHOLD) {
    try {
      return await process_large_file(connector, item, site_id, ctx);
    } catch (err) {
      logger.warn(
        `Skipping large file ${item.item_id} (${item.file_name}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  const raw_body = await download_with_retry(connector, item);
  if (!raw_body) return undefined;

  const checksum = compute_sha256_chunked(raw_body);
  const storage_key = sharepoint_data_key(site_id, checksum);
  const exists = await ctx.storage.exists(storage_key);

  if (!exists) {
    await ctx.storage.put(storage_key, ctx.encrypt(raw_body));
    return { storage_key, checksum, stored: true, deduplicated: false };
  }

  return { storage_key, checksum, stored: false, deduplicated: true };
}

/** @throws Error when no document libraries are returned (likely missing Graph permissions). */
export function ensure_libraries_discovered(library_count: number): void {
  if (library_count > 0) return;
  throw new Error(
    'Missing Microsoft Graph application permissions for SharePoint: Sites.Read.All.',
  );
}

/** Computes SHA-256 in chunks to avoid ERR_OUT_OF_RANGE on buffers > 2 GB. */
function compute_sha256_chunked(data: Buffer): string {
  const hash = createHash('sha256');
  for (let offset = 0; offset < data.length; offset += HASH_CHUNK_SIZE) {
    hash.update(data.subarray(offset, Math.min(offset + HASH_CHUNK_SIZE, data.length)));
  }
  return hash.digest('hex');
}
