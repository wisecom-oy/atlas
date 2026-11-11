import type { DriveWorkload } from '@/drive-ports';

/** How each drive workload is named in log lines and error messages. */
export const DRIVE_WORKLOAD_LABEL: Readonly<Record<DriveWorkload, string>> = {
  onedrive: 'OneDrive',
  sharepoint: 'SharePoint',
};
