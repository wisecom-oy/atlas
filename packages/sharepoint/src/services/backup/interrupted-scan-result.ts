import { finish_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import type { SharePointBackupOptions, SharePointBackupResult } from '@wisecom/atlas-types';
import { build_empty_result } from '@/services/backup/backup-builders';

/**
 * The result of a site backup cancelled before its scan finished: no snapshot, and the delta
 * cursor is untouched. Emits the closing progress events for it.
 */
export function interrupted_before_scan(
  site_id: string,
  options: SharePointBackupOptions,
): SharePointBackupResult {
  finish_operation_progress(options, 'backup', 'sharepoint', 0, 0, true);
  return build_empty_result(site_id, 0, 0, 0, 0, 0, 0, [], [], false, true, false);
}
