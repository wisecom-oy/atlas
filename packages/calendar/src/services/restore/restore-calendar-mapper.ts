import type { CalendarConnector, CalendarRecord, GraphCalendar } from '@wisecom/atlas-types';

import { error_message } from '@/services/shared/error-message';
import { is_run_fatal } from '@/services/shared/run-fatal-error';

/** Source-to-target calendar mapping produced before any event is written. */
export interface CalendarMapping {
  /** Target calendar id keyed by source calendar id. */
  readonly target_by_source: ReadonlyMap<string, string>;
  readonly calendars_created: number;
  readonly errors: string[];
}

/**
 * Keys calendars by display name. Every calendar in a mailbox is a folder in one namespace,
 * whatever calendar group shows it, and Exchange compares the names without case: creating `Work`
 * next to `work` fails with 409 `ErrorFolderExists`. The key ignores case too, so a target
 * calendar `work` receives the events of a source calendar `Work`.
 */
function name_key(display_name: string): string {
  return display_name.toLowerCase();
}

/** First writable target calendar id per name key; read-only calendars are never targets. */
function writable_by_name(calendars: readonly GraphCalendar[]): Map<string, string> {
  const by_name = new Map<string, string>();
  for (const calendar of calendars.filter((c) => c.can_edit)) {
    const key = name_key(calendar.display_name);
    if (!by_name.has(key)) by_name.set(key, calendar.id);
  }
  return by_name;
}

/**
 * Maps each source calendar onto the target mailbox: the default calendar to the target's
 * default, every other calendar to a writable target calendar of the same name (compared without
 * case), created when missing. A read-only target calendar of that name is never written into.
 */
export async function map_source_calendars(
  connector: CalendarConnector,
  target: { readonly tenant_id: string; readonly mailbox_id: string },
  source_calendars: readonly CalendarRecord[],
): Promise<CalendarMapping> {
  const existing = await connector.list_calendars(target.tenant_id, target.mailbox_id);
  const default_id = existing.find((calendar) => calendar.is_default)?.id;
  const by_name = writable_by_name(existing);
  const target_by_source = new Map<string, string>();
  const errors: string[] = [];
  let calendars_created = 0;

  for (const calendar of source_calendars) {
    const found = calendar.is_default ? default_id : by_name.get(name_key(calendar.display_name));
    if (found !== undefined) {
      target_by_source.set(calendar.calendar_id, found);
      continue;
    }
    if (calendar.is_default) {
      errors.push('The target mailbox has no default calendar');
      continue;
    }
    try {
      const created = await connector.create_calendar(
        target.tenant_id,
        target.mailbox_id,
        calendar.display_name,
      );
      by_name.set(name_key(calendar.display_name), created.id);
      target_by_source.set(calendar.calendar_id, created.id);
      calendars_created += 1;
    } catch (err) {
      if (is_run_fatal(err)) throw err;
      errors.push(`Calendar ${calendar.display_name} could not be created: ${error_message(err)}`);
    }
  }

  return { target_by_source, calendars_created, errors };
}
