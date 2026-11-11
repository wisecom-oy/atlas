import { create_drive_download_executor } from '@wisecom/atlas-drive/backup/drive-download-executor';
import { ONEDRIVE_CHUNK_DOWNLOADER } from '@/adapters/graph-onedrive-chunk-downloader';

/** The shared drive download executor, bound to OneDrive. */
export const ONEDRIVE_DOWNLOAD_EXECUTOR = create_drive_download_executor({
  workload: 'onedrive',
  read_permissions: 'Files.Read.All, Sites.Read.All',
  chunk_downloader: ONEDRIVE_CHUNK_DOWNLOADER,
});
