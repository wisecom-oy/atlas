import type {
  BackupProgressReporter,
  CalendarBackupOptions,
  GraphCalendar,
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

/**
 * Builds the run's reporter from the calendar list the caller's `create_progress` hook asks for,
 * or returns a reporter that discards events. Item totals are unknown before delta, so rows start at 0.
 */
export function resolve_backup_progress(
  options: CalendarBackupOptions,
  calendars: readonly GraphCalendar[],
): BackupProgressReporter {
  const rows = calendars.map((calendar) => ({ name: calendar.display_name, total_items: 0 }));
  return options.create_progress?.(rows) ?? NOOP_REPORTER;
}
