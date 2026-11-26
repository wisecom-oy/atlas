import type { FolderFailure, MailFolder } from '@wisecom/atlas-types';
import type { FolderSyncFailure } from '@/services/backup/failed-folder-result';

/**
 * The `folder_errors` line of a folder whose sync failed: its path, the message, and the Atlas code
 * when the failure has one, so the line says why without the operator reading a debug log
 * (issue #869).
 */
export function folder_error_line(folder_path: string, failure: FolderSyncFailure): string {
  const code = failure.error_code === undefined ? '' : ` (Atlas code: ${failure.error_code})`;
  return `${folder_path}: ${failure.error ?? 'failed'}${code}`;
}

/** The `folder_failures` record of a folder whose sync failed, for an SDK caller to branch on. */
export function to_folder_failure(folder: MailFolder, failure: FolderSyncFailure): FolderFailure {
  return {
    folder_id: folder.folder_id,
    folder_path: folder.folder_path,
    message: failure.error ?? 'failed',
    ...(failure.error_code !== undefined ? { code: failure.error_code } : {}),
    transient: failure.error_transient === true,
  };
}
