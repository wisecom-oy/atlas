import { logger } from '@wisecom/atlas-core/utils/logger';
import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
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
  abort_signal?: AbortSignal,
): Promise<FileProcessResult | undefined> {
  if (item.size_bytes >= LARGE_FILE_THRESHOLD) {
    try {
      return await process_large_drive_file(
        deps,
        connector,
        item,
        owner_id,
        ctx,
        undefined,
        abort_signal,
      );
    } catch (err) {
      // A cancelled run is not a bad file. Swallowing it records the item in the failed-item
      // ledger, and five cancellations of the same large file burn its retry budget and skip it
      // for good, because delta never re-presents an unchanged item (issue #344).
      if (abort_signal?.aborted === true) throw err;
      // A missing grant or a service refusal is not a skip: it must reach the caller
      // so the run can name the cause instead of reporting a lost file (issue #246).
      if (is_unretryable_download_failure(err)) throw err;
      logger.warn(
        `Skipping large file ${item.item_id} (${item.file_name}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  const raw_body = await download_with_retry(connector, item, { abort_signal });
  if (!raw_body) return undefined;

  const { checksum, content_name } = compute_content_digests(ctx, raw_body);
  const storage_key = deps.keys.data_key(owner_id, content_name);
  const exists = await ctx.storage.exists(storage_key);

  if (!exists) {
    await ctx.storage.put(storage_key, ctx.encrypt(raw_body, storage_key));
    return { storage_key, checksum, stored: true, deduplicated: false };
  }

  return { storage_key, checksum, stored: false, deduplicated: true };
}
