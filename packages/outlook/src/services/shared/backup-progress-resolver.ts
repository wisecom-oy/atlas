import type { BackupProgressReporter, MailFolder } from '@wisecom/atlas-types';

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

export interface ProgressReporterOptions {
  readonly progress?: BackupProgressReporter | undefined;
  readonly create_progress?:
    ((folders: { name: string; total_items: number }[]) => BackupProgressReporter) | undefined;
}

/**
 * Picks the progress reporter for a run: the caller's own, one it asks us to
 * build for the resolved folder list, or a reporter that discards.
 *
 * The folder list has to be resolved first, because a dashboard sizes its rows
 * from the folders the run will actually walk.
 */
export function resolve_progress_reporter(
  options: ProgressReporterOptions,
  folders: MailFolder[],
): BackupProgressReporter {
  if (options.progress) return options.progress;
  const built = options.create_progress?.(
    folders.map((f) => ({ name: f.folder_path, total_items: f.total_item_count })),
  );
  return built ?? NOOP_BACKUP_PROGRESS_REPORTER;
}
