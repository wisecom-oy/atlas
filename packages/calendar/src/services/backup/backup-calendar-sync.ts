import type { CalendarEventEntry, GraphCalendar, GraphEventPayload } from '@wisecom/atlas-types';
import { type EventStoreDeps, store_event_entry } from '@/services/backup/backup-event-store';
import { error_message } from '@/services/shared/error-message';
import { is_run_fatal } from '@/services/shared/run-fatal-error';

/** Exchange allows four concurrent requests per mailbox; more only queue in the limiter. */
const EVENT_CONCURRENCY = 4;

/** Shared inputs for syncing every calendar of one mailbox in one run. */
export interface CalendarSyncDeps extends EventStoreDeps {
  readonly should_interrupt: () => boolean;
}

/**
 * A calendar synced to its final state, or one left partway when the run was interrupted.
 * `delta_link` is undefined when the calendar must be re-read in full next run.
 */
export type CalendarSyncResult =
  | {
      readonly complete: true;
      readonly entries: readonly CalendarEventEntry[];
      readonly delta_link: string | undefined;
      readonly objects_stored: number;
      readonly errors: readonly string[];
      readonly warnings: readonly string[];
    }
  | { readonly complete: false; readonly objects_stored: number };

function describe_event(event: GraphEventPayload): string {
  const subject = event['subject'];
  return typeof subject === 'string' && subject !== '' ? `"${subject}" (${event.id})` : event.id;
}

/** Mutable merge state of one calendar while its events are stored. */
interface CalendarMerge {
  readonly by_id: Map<string, CalendarEventEntry>;
  readonly previous_by_id: ReadonlyMap<string, CalendarEventEntry>;
  readonly errors: string[];
  readonly warnings: string[];
  objects_stored: number;
}

/**
 * Stores one event into the merge. A non-fatal failure is recorded and the event falls back to
 * its previous entry; a run-fatal failure is thrown.
 */
async function apply_event(
  deps: CalendarSyncDeps,
  calendar: GraphCalendar,
  event: GraphEventPayload,
  merge: CalendarMerge,
): Promise<void> {
  try {
    const stored = await store_event_entry(deps, calendar.id, event);
    merge.objects_stored += stored.objects_stored;
    merge.by_id.set(event.id, stored.entry);
    for (const warning of stored.warnings) {
      merge.warnings.push(`Event ${describe_event(event)} in ${calendar.display_name}: ${warning}`);
    }
  } catch (err) {
    if (is_run_fatal(err)) throw err;
    merge.errors.push(
      `Event ${describe_event(event)} in ${calendar.display_name} failed: ${error_message(err)}`,
    );
    const prior = merge.previous_by_id.get(event.id);
    if (prior === undefined) merge.by_id.delete(event.id);
    else merge.by_id.set(event.id, prior);
  }
}

/**
 * Applies one calendar's delta over `base` (the previous snapshot's entries for that calendar).
 * A full read (no link, or a reset) replaces the base with the calendar's current contents.
 *
 * An event that fails to store keeps its previous entry and is reported; the rest of the calendar
 * still lands. The calendar then keeps its old delta link so the next run delivers the failed
 * event again, and a reset calendar keeps no link because its old one was rejected.
 */
export async function sync_calendar(
  deps: CalendarSyncDeps,
  calendar: GraphCalendar,
  base: readonly CalendarEventEntry[],
  delta_link: string | undefined,
): Promise<CalendarSyncResult> {
  const delta = await deps.connector.fetch_event_delta(
    deps.tenant_id,
    deps.mailbox_id,
    calendar.id,
    delta_link,
  );
  const full_read = delta_link === undefined || delta.reset;
  const previous_by_id = new Map(base.map((entry) => [entry.event_id, entry]));
  const merge: CalendarMerge = {
    by_id: new Map(full_read ? [] : previous_by_id),
    previous_by_id,
    errors: [],
    warnings: [],
    objects_stored: 0,
  };
  for (const removed_id of delta.removed_ids) merge.by_id.delete(removed_id);

  let interrupted = false;
  let fatal: Error | undefined;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < delta.upserted.length && fatal === undefined && !interrupted) {
      if (deps.should_interrupt()) {
        interrupted = true;
        return;
      }
      const event = delta.upserted[next++];
      if (event === undefined) return;
      try {
        await apply_event(deps, calendar, event, merge);
      } catch (err) {
        fatal = err instanceof Error ? err : new Error(String(err));
      }
    }
  };
  const workers = Math.min(EVENT_CONCURRENCY, delta.upserted.length);
  await Promise.all(Array.from({ length: workers }, worker));
  if (fatal !== undefined) throw fatal;
  if (interrupted) return { complete: false, objects_stored: merge.objects_stored };

  const retry_link = delta.reset ? undefined : delta_link;
  return {
    complete: true,
    entries: [...merge.by_id.values()],
    delta_link: merge.errors.length === 0 ? delta.delta_link : retry_link,
    objects_stored: merge.objects_stored,
    errors: merge.errors,
    warnings: merge.warnings,
  };
}
