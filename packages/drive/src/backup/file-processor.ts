import { logger } from '@wisecom/atlas-core/utils/logger';
import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import { is_listed_size_part_limit_refusal } from '@wisecom/atlas-core/services/shared/multipart-part-plan';
import { is_unretryable_download_failure } from '@wisecom/atlas-m365-graph';
import type { TenantContext } from '@wisecom/atlas-types';
import { download_with_retry } from '@/backup/download-retry';
import { is_download_size_changed } from '@/backup/download-integrity';
import { attempt_with_size_refresh, type DriveItemRefetch } from '@/backup/download-size-refresh';
import { LARGE_FILE_THRESHOLD } from '@/backup/large-file-threshold';
import {
  process_large_drive_file,
  type DriveDownloadUrlResolver,
  type DriveLargeFileDeps,
} from '@/backup/large-file-pipeline';
import { is_download_url_expired } from '@/backup/large-file-url-refresh';
import { is_storage_failure } from '@/backup/storage-failure';
import { transient_download_error_for } from '@/backup/transient-download-failure';
import type { DriveContentConnector, DriveDeltaItem } from '@/drive-ports';

export interface FileProcessResult {
  storage_key: string;
  checksum: string;
  stored: boolean;
  deduplicated: boolean;
  /** Length of the content actually stored, which can differ from the listed size (issue #759). */
  size_bytes: number;
}

/**
 * Downloads or deduplicates a single delta file item.
 *
 * `refetch_item` re-reads the item once if its size changed during the download (issue #759).
 * Undefined means the file's own fault ended the download; a failure outside the file throws
 * `TransientDownloadError` instead, so the caller can spare the file's ledger attempt (#857). A
 * storage failure is thrown unchanged at either size, so it fails the drive, not the file (#917).
 */
export async function process_drive_backup_file(
  deps: DriveLargeFileDeps,
  connector: DriveContentConnector & DriveDownloadUrlResolver,
  item: DriveDeltaItem,
  owner_id: string,
  ctx: TenantContext,
  refetch_item: DriveItemRefetch,
  abort_signal?: AbortSignal,
): Promise<FileProcessResult | undefined> {
  return attempt_with_size_refresh(
    item,
    refetch_item,
    (current) => store_drive_file(deps, connector, current, owner_id, ctx, abort_signal),
    abort_signal,
  );
}

/** One download-and-store attempt for a file planned with the item's current size. */
async function store_drive_file(
  deps: DriveLargeFileDeps,
  connector: DriveContentConnector & DriveDownloadUrlResolver,
  item: DriveDeltaItem,
  owner_id: string,
  ctx: TenantContext,
  abort_signal?: AbortSignal,
): Promise<FileProcessResult | undefined> {
  if (item.size_bytes >= LARGE_FILE_THRESHOLD) {
    return process_large_or_skip(deps, connector, item, owner_id, ctx, abort_signal);
  }

  const raw_body = await download_with_retry(connector, item, { abort_signal });
  if (!raw_body) return undefined;

  const { checksum, content_name } = compute_content_digests(ctx, raw_body);
  const storage_key = deps.keys.data_key(owner_id, content_name);
  const exists = await ctx.storage.exists(storage_key);
  const size_bytes = raw_body.length;

  if (!exists) {
    await ctx.storage.put(storage_key, ctx.encrypt(raw_body, storage_key));
    return { storage_key, checksum, stored: true, deduplicated: false, size_bytes };
  }

  return { storage_key, checksum, stored: false, deduplicated: true, size_bytes };
}

/**
 * Streams a large file, returning undefined for a failure of the file's own the run carries on past,
 * throwing `TransientDownloadError` for a download failure outside the file, and rethrowing a
 * storage failure unchanged.
 */
async function process_large_or_skip(
  deps: DriveLargeFileDeps,
  connector: DriveContentConnector & DriveDownloadUrlResolver,
  item: DriveDeltaItem,
  owner_id: string,
  ctx: TenantContext,
  abort_signal?: AbortSignal,
): Promise<FileProcessResult | undefined> {
  try {
    const result = await process_large_drive_file(
      deps,
      connector,
      item,
      owner_id,
      ctx,
      undefined,
      abort_signal,
    );
    // The stream verified its length against the planned size, so that is the stored length.
    return { ...result, size_bytes: item.size_bytes };
  } catch (err) {
    rethrow_unless_skippable(err, abort_signal);
    logger.warn(
      `Skipping large file ${item.item_id} (${item.file_name}): ${err instanceof Error ? err.message : String(err)}`,
    );
    // Throttling, an outage, a reset or a timeout: recorded without spending an attempt (#857).
    const transient = transient_download_error_for(
      err,
      `large file ${item.file_name} (${item.item_id})`,
    );
    if (transient) throw transient;
    return undefined;
  }
}

/** Rethrows every failure that must reach the caller instead of becoming a skipped file. */
function rethrow_unless_skippable(err: unknown, abort_signal?: AbortSignal): void {
  // A cancelled run is not a bad file. Swallowing it records the item in the failed-item ledger,
  // and five cancellations of the same large file burn its retry budget and skip it for good,
  // because delta never re-presents an unchanged item (issue #344).
  if (abort_signal?.aborted === true) throw err;
  // Storage failed, not the file: a full disk or quota, an S3 5xx after the SDK's retries, a refused
  // completion or copy, or an endpoint that never answered. Rethrown as a small file's failed put
  // is, so it fails the drive or library with its own exit code and spends no attempt (issue #917).
  if (is_storage_failure(err)) throw err;
  // A missing grant or a service refusal is not a skip: it must reach the caller so the run can
  // name the cause instead of reporting a lost file (issue #246).
  if (is_unretryable_download_failure(err)) throw err;
  // The URL kept expiring, not the file: the caller records it without spending an attempt (#718).
  if (is_download_url_expired(err)) throw err;
  // The size changed under the transfer: the caller re-reads the item once (issue #759).
  if (is_download_size_changed(err)) throw err;
  // Too large for the multipart part limit at any part size Atlas uses. Refused before any part
  // was uploaded, and the caller records it as not retried, since every run would refuse it again
  // until the file changes (issue #925).
  if (is_listed_size_part_limit_refusal(err)) throw err;
}
