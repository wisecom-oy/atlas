import type {
  BackupProgressReporter,
  BackupSyncMode,
  MailFolder,
  SyncOptions,
} from '@wisecom/atlas-types';

/** Discards every progress event, for callers that pass no reporter. */
class NoopBackupProgressReporter implements BackupProgressReporter {
  set_status(): void {}
  mark_active(): void {}
  update_active(): void {}
  update_paging(): void {}
  mark_done(): void {}
  mark_all_pending_interrupted(): void {}
  mark_error(): void {}
  update_total(): void {}
  finish(): void {}
}

export const NOOP_BACKUP_PROGRESS_REPORTER = new NoopBackupProgressReporter();

/**
 * Picks the progress reporter for a run: the caller's own, one it asks us to
 * build for the resolved folder list, or a reporter that discards.
 *
 * The folder list has to be resolved first, because a dashboard sizes its rows
 * from the folders the run will actually walk.
 */
export function resolve_progress_reporter(
  options: Pick<SyncOptions, 'progress' | 'create_progress'>,
  folders: MailFolder[],
  mode: BackupSyncMode,
): BackupProgressReporter {
  if (options.progress) return options.progress;
  const built = options.create_progress?.(
    folders.map((f) => ({ name: f.folder_path, total_items: f.total_item_count })),
    mode,
  );
  return built ?? NOOP_BACKUP_PROGRESS_REPORTER;
}
