import type { OneDriveRestoreResult } from '@wisecom/atlas-types';

/** Builds the interrupted result returned before restore work starts. */
export function empty_restore_result(snapshot_id: string): OneDriveRestoreResult {
  return {
    snapshot_id,
    files_restored: 0,
    folders_created: 0,
    files_skipped: 0,
    errors: [],
    interrupted: true,
  };
}
