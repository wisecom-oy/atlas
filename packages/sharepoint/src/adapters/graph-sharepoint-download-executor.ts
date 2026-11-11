import { create_drive_download_executor } from '@wisecom/atlas-drive/backup/drive-download-executor';
import { SHAREPOINT_CHUNK_DOWNLOADER } from '@/adapters/graph-sharepoint-chunk-downloader';

/** The shared drive download executor, bound to SharePoint. */
export const SHAREPOINT_DOWNLOAD_EXECUTOR = create_drive_download_executor({
  workload: 'sharepoint',
  read_permissions: 'Sites.Read.All',
  chunk_downloader: SHAREPOINT_CHUNK_DOWNLOADER,
});
