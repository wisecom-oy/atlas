import type { SharePointRestoreOptions, SharePointRestoreResult } from '@wisecom/atlas-types';

/** True once the caller asked the run to stop, by flag or by abort signal. */
export function is_run_interrupted(options: SharePointRestoreOptions): boolean {
  return options.should_interrupt?.() === true || options.abort_signal?.aborted === true;
}

/** The result of a restore that stopped before restoring anything. */
export function empty_restore_result(snapshot_id: string): SharePointRestoreResult {
  return {
    snapshot_id,
    files_restored: 0,
    folders_created: 0,
    files_skipped: 0,
    errors: [],
    interrupted: true,
  };
}
