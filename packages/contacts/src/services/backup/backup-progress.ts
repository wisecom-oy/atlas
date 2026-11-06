import type {
  BackupProgressReporter,
  GraphContactFolder,
  ContactsBackupOptions,
} from '@wisecom/atlas-types';

/** Discards every progress event, for callers that pass no `create_progress` hook. */
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

const NOOP_REPORTER = new NoopBackupProgressReporter();

/** Row label: the display name for the default folder, otherwise the folder path. */
function folder_label(folder: GraphContactFolder): string {
  return folder.path.length === 0 ? folder.display_name : folder.path.join('/');
}

/**
 * Builds the run's reporter from the folder list the caller's `create_progress` hook asks for,
 * or returns a reporter that discards events. Item totals are unknown before delta, so rows start at 0.
 */
export function resolve_backup_progress(
  options: ContactsBackupOptions,
  folders: readonly GraphContactFolder[],
): BackupProgressReporter {
  const rows = folders.map((folder) => ({ name: folder_label(folder), total_items: 0 }));
  return options.create_progress?.(rows) ?? NOOP_REPORTER;
}
