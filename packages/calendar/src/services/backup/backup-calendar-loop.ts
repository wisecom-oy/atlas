import type {
  BackupProgressReporter,
  CalendarEventEntry,
  GraphCalendar,
  OperationControlOptions,
} from '@wisecom/atlas-types';
import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import {
  type CalendarSyncDeps,
  type CalendarSyncResult,
  sync_calendar,
} from '@/services/backup/backup-calendar-sync';
import { is_run_fatal } from '@/services/shared/run-fatal-error';
import { error_message } from '@/services/shared/error-message';
import { append_all } from '@wisecom/atlas-core/utils/append-all';

/** Final entries and delta links for every synced calendar, plus run-level counts. */
export interface CalendarLoopOutcome {
  readonly entries: readonly CalendarEventEntry[];
  readonly delta_link_by_calendar: Record<string, string>;
  readonly objects_stored: number;
  readonly attachments_skipped: number;
  readonly errors: string[];
  readonly warnings: string[];
  readonly interrupted: boolean;
}

/**
 * One calendar's state after the loop. `fresh` is false when the calendar was not synced this run
 * and carries the previous snapshot's entries instead.
 */
interface CalendarState {
  readonly entries: readonly CalendarEventEntry[];
  readonly delta_link?: string | undefined;
  readonly fresh: boolean;
}

/** Inputs describing the previous, consistent state of the mailbox. */
export interface CalendarLoopState {
  readonly previous_entries: readonly CalendarEventEntry[];
  readonly read_links: Readonly<Record<string, string>>;
  readonly kept_links: Readonly<Record<string, string>>;
}

function previous_state_for(calendar: GraphCalendar, state: CalendarLoopState): CalendarState {
  const entries = state.previous_entries.filter((entry) => entry.calendar_id === calendar.id);
  return { entries, delta_link: state.kept_links[calendar.id], fresh: false };
}

/** Run-level counters every calendar adds to. */
interface RunTotals {
  readonly errors: string[];
  readonly warnings: string[];
  objects_stored: number;
  attachments_skipped: number;
}

/** Marks a synced calendar's progress row done, or failed when events failed or attachments were left out. */
function report_calendar_outcome(
  reporter: BackupProgressReporter,
  index: number,
  result: Extract<CalendarSyncResult, { complete: true }>,
): void {
  if (result.errors.length > 0) {
    reporter.mark_error(index, `${result.errors.length} event(s) failed`);
  } else if (result.attachments_skipped > 0) {
    reporter.mark_error(index, `${result.attachments_skipped} attachment(s) not captured`);
  } else {
    reporter.mark_done(index, result.objects_stored, 0, 0);
  }
}

/**
 * Syncs one calendar and records its outcome. Returns the calendar's state, and whether the run
 * was interrupted inside it; a failed calendar keeps its previous state.
 */
async function sync_one_calendar(
  deps: CalendarSyncDeps,
  calendar: GraphCalendar,
  index: number,
  previous: CalendarState,
  read_link: string | undefined,
  reporter: BackupProgressReporter,
  totals: RunTotals,
): Promise<{ readonly state: CalendarState; readonly interrupted: boolean }> {
  reporter.mark_active(index);
  try {
    const result = await sync_calendar(deps, calendar, previous.entries, read_link);
    totals.objects_stored += result.objects_stored;
    if (!result.complete) return { state: previous, interrupted: true };
    totals.attachments_skipped += result.attachments_skipped;
    append_all(totals.errors, result.errors);
    append_all(totals.warnings, result.warnings);
    report_calendar_outcome(reporter, index, result);
    return {
      state: { entries: result.entries, delta_link: result.delta_link, fresh: true },
      interrupted: false,
    };
  } catch (err) {
    if (is_run_fatal(err)) throw err;
    // A Graph call cut short by cancellation is the run stopping, not the calendar failing.
    if (deps.should_interrupt()) return { state: previous, interrupted: true };
    const message = error_message(err);
    totals.errors.push(`Calendar ${calendar.display_name} failed: ${message}`);
    reporter.mark_error(index, message);
    return { state: previous, interrupted: false };
  }
}

/**
 * Syncs every listed calendar in order. Calendars that are interrupted or fail keep their
 * previous entries and delta link, so the next run retries them from a consistent point. Auth
 * and licence failures end the run, since no other calendar can succeed either.
 */
export async function sync_all_calendars(
  deps: CalendarSyncDeps,
  calendars: readonly GraphCalendar[],
  state: CalendarLoopState,
  control: OperationControlOptions,
  reporter: BackupProgressReporter,
): Promise<CalendarLoopOutcome> {
  const states: CalendarState[] = [];
  const totals: RunTotals = { errors: [], warnings: [], objects_stored: 0, attachments_skipped: 0 };
  let interrupted = false;
  for (const [index, calendar] of calendars.entries()) {
    const previous = previous_state_for(calendar, state);
    if (interrupted || deps.should_interrupt()) {
      interrupted = true;
      states.push(previous);
      continue;
    }
    const link = state.read_links[calendar.id];
    const outcome = await sync_one_calendar(
      deps,
      calendar,
      index,
      previous,
      link,
      reporter,
      totals,
    );
    states.push(outcome.state);
    interrupted = outcome.interrupted;
    emit_operation_progress(control, {
      operation: 'backup',
      workload: 'calendar',
      phase: 'processing',
      processed: index + 1,
      total: calendars.length,
    });
  }
  if (interrupted) reporter.mark_all_pending_interrupted();
  return {
    entries: merge_calendar_entries(states),
    delta_link_by_calendar: collect_links(calendars, states),
    ...totals,
    interrupted,
  };
}

/**
 * Flattens calendar states. An event moved out of a calendar that failed this run into one that
 * synced would otherwise appear twice; the synced calendar's view wins because it is current.
 */
function merge_calendar_entries(states: readonly CalendarState[]): CalendarEventEntry[] {
  const fresh_ids = new Set(
    states.filter((s) => s.fresh).flatMap((s) => s.entries.map((entry) => entry.event_id)),
  );
  return states.flatMap((s) =>
    s.fresh ? [...s.entries] : s.entries.filter((entry) => !fresh_ids.has(entry.event_id)),
  );
}

function collect_links(
  calendars: readonly GraphCalendar[],
  states: readonly CalendarState[],
): Record<string, string> {
  const links: Record<string, string> = {};
  for (const [index, calendar] of calendars.entries()) {
    const link = states[index]?.delta_link;
    if (link !== undefined) links[calendar.id] = link;
  }
  return links;
}
