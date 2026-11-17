import { create_drive_download_executor } from '@wisecom/atlas-drive/backup/drive-download-executor';
import { SHAREPOINT_CHUNK_DOWNLOADER } from '@/adapters/graph-sharepoint-chunk-downloader';
import { can_read_root_site } from '@/adapters/graph-root-site-check';

/**
 * The shared drive download executor, bound to SharePoint. A 403 on enumeration is checked against
 * the tenant's root site, so a site Graph refuses while the root site is readable is not reported
 * as a missing grant (issue #772).
 */
export const SHAREPOINT_DOWNLOAD_EXECUTOR = create_drive_download_executor({
  workload: 'sharepoint',
  read_permissions: ['Sites.Read.All'],
  grant_alternative: 'a Sites.Selected grant on this site',
  verify_read_grant: can_read_root_site,
  chunk_downloader: SHAREPOINT_CHUNK_DOWNLOADER,
});
