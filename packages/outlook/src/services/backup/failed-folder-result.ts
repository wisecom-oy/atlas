import {
  AtlasError,
  type AtlasErrorCode,
  type OperationControlOptions,
} from '@wisecom/atlas-types';
import { is_graph_outage } from '@wisecom/atlas-core/services/shared/graph-outage-latch';
import type { FolderSyncResult } from '@/services/backup/folder-sync-executor';

/** Why a folder's sync failed as a whole: the message, and how Atlas classified the failure. */
export interface FolderSyncFailure {
  /** The error message, without the folder path. */
  readonly error?: string;
  /** The Atlas code of the failure, or undefined for an error Atlas did not classify. */
  readonly error_code?: AtlasErrorCode;
  /** True for a Graph call that spent its retry budget: Microsoft 365 was unavailable. */
  readonly error_transient?: boolean;
}

/**
 * The result of a folder whose sync threw: no entries, no delta link, and the error to report.
 *
 * A Graph call cut short by cancellation is the run stopping, not the folder failing, so it carries
 * no error. Any other failure carries its Atlas code, so the folder's error line and the SDK result
 * can say why it failed. The folder keeps its old delta link either way and the caller sees the interrupt
 * (issue #673).
 */
export function failed_folder_result(
  err: unknown,
  control: OperationControlOptions,
): FolderSyncResult & FolderSyncFailure {
  return {
    entries: [],
    removed_ids: [],
    delta_link: '',
    complete: false,
    stored: 0,
    deduplicated: 0,
    attachments_stored: 0,
    message_errors: [],
    message_losses: [],
    folder_processed: 0,
    warnings: [],
    reactions_not_captured: 0,
    ...(control.abort_signal?.aborted === true ? {} : classify_folder_failure(err)),
  };
}

/** The message, Atlas code and transience of the error a folder's sync threw (issue #869). */
export function classify_folder_failure(err: unknown): FolderSyncFailure {
  return {
    error: error_text(err),
    ...(err instanceof AtlasError ? { error_code: err.code } : {}),
    error_transient: is_graph_outage(err),
  };
}

function error_text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
