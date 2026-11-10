import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import type { CalendarEventEntry, OperationControlOptions } from '@wisecom/atlas-types';

import {
  type EntryOutcome,
  type ExistingEvents,
  restore_entry,
  type RestoreWriteDeps,
} from '@/services/restore/restore-event-writer';
import { error_message } from '@/services/shared/error-message';
import { is_run_fatal } from '@/services/shared/run-fatal-error';
import { pending_tag_of, source_ical_uid_of, source_tag_of } from '@/services/shared/source-tag';

function describe_entry(entry: CalendarEventEntry): string {
  return entry.subject ? `"${entry.subject}" (${entry.event_id})` : entry.event_id;
}

export interface RestoreLoopOutcome {
  readonly processed: number;
  readonly restored: number;
  readonly skipped: number;
  readonly errors: string[];
  readonly interrupted: boolean;
}

/** Loads what a target calendar already holds once, reused for every entry that targets it. */
async function existing_events_for(
  deps: RestoreWriteDeps,
  calendar_id: string,
  cache: Map<string, ExistingEvents>,
): Promise<ExistingEvents> {
  const cached = cache.get(calendar_id);
  if (cached !== undefined) return cached;
  const events = await deps.connector.list_calendar_events(
    deps.tenant_id,
    deps.target_mailbox_id,
    calendar_id,
  );
  const existing: ExistingEvents = {
    ical_uids: new Set(),
    source_ids: new Set(),
    incomplete: new Map(),
  };
  for (const event of events) {
    if (typeof event['iCalUId'] === 'string') existing.ical_uids.add(event['iCalUId']);
    const source = source_tag_of(event);
    if (source !== undefined) existing.source_ids.add(source);
    const restored_uid = source_ical_uid_of(event);
    if (restored_uid !== undefined) existing.ical_uids.add(restored_uid);
    const pending = pending_tag_of(event);
    if (pending !== undefined) existing.incomplete.set(pending, event.id);
  }
  cache.set(calendar_id, existing);
  return existing;
}

/** Restores one entry into the target calendar its source calendar was mapped to. */
async function restore_mapped_entry(
  deps: RestoreWriteDeps,
  entry: CalendarEventEntry,
  target_by_source: ReadonlyMap<string, string>,
  cache: Map<string, ExistingEvents>,
): Promise<EntryOutcome> {
  const calendar_id = target_by_source.get(entry.calendar_id);
  if (calendar_id === undefined)
    throw new Error('source calendar was not mapped to a target calendar');
  const existing = await existing_events_for(deps, calendar_id, cache);
  return restore_entry(deps, entry, calendar_id, existing);
}

/**
 * Restores every manifest entry in order. A failed entry is recorded and the run continues;
 * auth and licence failures end the run. Interruption is checked before each entry.
 */
export async function restore_all_entries(
  deps: RestoreWriteDeps,
  entries: readonly CalendarEventEntry[],
  target_by_source: ReadonlyMap<string, string>,
  control: OperationControlOptions,
): Promise<RestoreLoopOutcome> {
  const cache = new Map<string, ExistingEvents>();
  const errors: string[] = [];
  let processed = 0;
  let restored = 0;
  let skipped = 0;
  let interrupted = false;

  for (const entry of entries) {
    if (control.should_interrupt?.() === true || control.abort_signal?.aborted === true) {
      interrupted = true;
      break;
    }
    processed += 1;
    try {
      const outcome = await restore_mapped_entry(deps, entry, target_by_source, cache);
      if (outcome.status === 'skipped') {
        skipped += 1;
      } else {
        restored += 1;
        for (const partial of outcome.partial_errors) {
          errors.push(`Event ${describe_entry(entry)} restored, but ${partial}`);
        }
      }
    } catch (err) {
      if (is_run_fatal(err)) throw err;
      errors.push(`Event ${describe_entry(entry)} failed to restore: ${error_message(err)}`);
    }
    emit_operation_progress(control, {
      operation: 'restore',
      workload: 'calendar',
      phase: 'processing',
      processed,
      total: entries.length,
    });
  }

  return { processed, restored, skipped, errors, interrupted };
}
