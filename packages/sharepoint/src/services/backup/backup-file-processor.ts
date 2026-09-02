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
): Promise<FileProcessResult | undefined> {
  return process_drive_backup_file(SHAREPOINT_LARGE_FILE_DEPS, connector, item, site_id, ctx);
}

/** @throws Error when no document libraries are returned (likely missing Graph permissions). */
export function ensure_libraries_discovered(library_count: number): void {
  if (library_count > 0) return;
  throw new Error(
    'Missing Microsoft Graph application permissions for SharePoint: Sites.Read.All.',
  );
}
