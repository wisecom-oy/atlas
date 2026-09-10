import type { OneDriveConnector, OneDriveDeltaItem, TenantContext } from '@wisecom/atlas-types';
import {
  process_drive_backup_file,
  type FileProcessResult,
} from '@wisecom/atlas-drive/backup/file-processor';
import { ONEDRIVE_LARGE_FILE_DEPS } from '@/services/backup/large-file-pipeline';

export type { FileProcessResult } from '@wisecom/atlas-drive/backup/file-processor';

/** Downloads or deduplicates a single delta file item. */
export async function process_backup_file(
  connector: OneDriveConnector,
  item: OneDriveDeltaItem,
  owner_id: string,
  ctx: TenantContext,
  abort_signal?: AbortSignal,
): Promise<FileProcessResult | undefined> {
  return process_drive_backup_file(
    ONEDRIVE_LARGE_FILE_DEPS,
    connector,
    item,
    owner_id,
    ctx,
    abort_signal,
  );
}
