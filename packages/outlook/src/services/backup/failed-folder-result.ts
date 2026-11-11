import type { OperationControlOptions } from '@wisecom/atlas-types';
import type { FolderSyncResult } from '@/services/backup/folder-sync-executor';

/**
 * The result of a folder whose sync threw: no entries, no delta link, and the error to report.
 *
 * A Graph call cut short by cancellation is the run stopping, not the folder failing, so it carries
 * no error. The folder keeps its old delta link either way and the caller sees the interrupt
 * (issue #673).
 */
export function failed_folder_result(
  err: unknown,
  control: OperationControlOptions,
): FolderSyncResult & { error?: string } {
  return {
    entries: [],
    removed_ids: [],
    delta_link: '',
    complete: false,
    stored: 0,
    deduplicated: 0,
    attachments_stored: 0,
    message_errors: [],
    folder_processed: 0,
    warnings: [],
    reactions_not_captured: 0,
    ...(control.abort_signal?.aborted === true ? {} : { error: error_text(err) }),
  };
}

function error_text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
