import type {
  SharePointDeltaItem,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  process_drive_backup_file,
  type FileProcessResult,
} from '@wisecom/atlas-drive/backup/file-processor';
import { SHAREPOINT_LARGE_FILE_DEPS } from '@/services/backup/large-file-pipeline';

export type { FileProcessResult } from '@wisecom/atlas-drive/backup/file-processor';

/** Downloads or deduplicates a single delta file item. */
export async function process_backup_file(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  ctx: TenantContext,
  abort_signal?: AbortSignal,
): Promise<FileProcessResult | undefined> {
  return process_drive_backup_file(
    SHAREPOINT_LARGE_FILE_DEPS,
    connector,
    item,
    site_id,
    ctx,
    abort_signal,
  );
}
