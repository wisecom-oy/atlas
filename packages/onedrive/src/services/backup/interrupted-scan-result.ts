import { finish_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import type { OneDriveBackupOptions, OneDriveBackupResult } from '@wisecom/atlas-types';
import { build_empty_result } from '@/services/backup/backup-builders';

/** A run cancelled before its scan finished: no snapshot, and the delta cursor is untouched. */
export function interrupted_before_scan(
  owner_id: string,
  options: OneDriveBackupOptions,
): OneDriveBackupResult {
  finish_operation_progress(options, 'backup', 'onedrive', 0, 0, true);
  return build_empty_result(owner_id, 0, 0, 0, 0, 0, 0, [], [], true, false, false);
}
