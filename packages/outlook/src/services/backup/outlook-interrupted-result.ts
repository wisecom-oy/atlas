import type { BackupProgressReporter, SyncOptions, SyncResult } from '@wisecom/atlas-types';
import {
  build_manifest,
  create_pending_snapshot,
  mark_snapshot_completed,
  resolve_sync_mode,
} from '@/services/backup/snapshot-manifest-builder';

/** Builds a zero-work result when backup is cancelled before discovery. */
export function build_interrupted_result(
  tenant_id: string,
  owner_id: string,
  options: SyncOptions,
): SyncResult {
  const pending = create_pending_snapshot(tenant_id, owner_id, {
    owner_email: options.owner_email,
    owner_display_name: options.owner_display_name,
  });
  const snapshot = mark_snapshot_completed(pending, 0);
  return {
    snapshot,
    manifest: build_manifest(owner_id, snapshot.id, [], {}),
    mode: resolve_sync_mode(options.force_full, {}),
    interrupted: true,
    summary: {
      stored: 0,
      deduplicated: 0,
      attachments_stored: 0,
      processed: 0,
      folder_errors: [],
      warnings: [],
      interrupted: true,
      completed_folder_count: 0,
      total_folder_count: 0,
      elapsed_ms: 0,
      excluded_folders: [],
    },
  };
}

/** Marks pending dashboard rows and preserves the interruption state. */
export function mark_progress_interrupted(
  progress: BackupProgressReporter,
  interrupted: boolean,
): boolean {
  if (interrupted) progress.mark_all_pending_interrupted();
  return interrupted;
}
