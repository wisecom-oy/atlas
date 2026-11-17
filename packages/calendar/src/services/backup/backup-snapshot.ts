import { randomBytes } from 'node:crypto';
import type {
  CalendarEventEntry,
  CalendarRecord,
  CalendarSnapshotManifest,
} from '@wisecom/atlas-types';

/** Counts of events added or changed, and of events that disappeared, between two states. */
export interface EntryChangeCounts {
  readonly changed: number;
  readonly removed: number;
}

function attachment_keys(entry: CalendarEventEntry): string {
  return (entry.attachments ?? []).map((a) => a.storage_key).join('\n');
}

/** Compares final entries with the previous snapshot's entries, by event id. */
export function compare_entries(
  previous: readonly CalendarEventEntry[],
  entries: readonly CalendarEventEntry[],
): EntryChangeCounts {
  const prior_by_id = new Map(previous.map((entry) => [entry.event_id, entry]));
  const current_ids = new Set(entries.map((entry) => entry.event_id));
  let changed = 0;
  for (const entry of entries) {
    const prior = prior_by_id.get(entry.event_id);
    const unchanged =
      prior !== undefined &&
      prior.calendar_id === entry.calendar_id &&
      prior.storage_key === entry.storage_key &&
      attachment_keys(prior) === attachment_keys(entry);
    if (!unchanged) changed += 1;
  }
  let removed = 0;
  for (const id of prior_by_id.keys()) {
    if (!current_ids.has(id)) removed += 1;
  }
  return { changed, removed };
}

/** Whether the calendar list differs from the previous snapshot's; no previous snapshot means no difference. */
export function calendars_differ(
  previous: readonly CalendarRecord[] | undefined,
  calendars: readonly CalendarRecord[],
): boolean {
  if (previous === undefined) return false;
  return JSON.stringify(previous) !== JSON.stringify(calendars);
}

/** Builds a snapshot id of the form `cal-snap-<ms>-<hex>`. */
export function new_snapshot_id(now_ms: number): string {
  return `cal-snap-${now_ms}-${randomBytes(3).toString('hex')}`;
}

/** Assembles a full, self-contained manifest from the final entry set. */
export function build_snapshot_manifest(input: {
  readonly tenant_id: string;
  readonly mailbox_id: string;
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly calendars: readonly CalendarRecord[];
  readonly entries: readonly CalendarEventEntry[];
}): CalendarSnapshotManifest {
  const total_size_bytes = input.entries.reduce(
    (sum, entry) =>
      sum + entry.size_bytes + (entry.attachments ?? []).reduce((s, a) => s + a.size_bytes, 0),
    0,
  );
  return {
    id: input.snapshot_id,
    tenant_id: input.tenant_id,
    mailbox_id: input.mailbox_id,
    snapshot_id: input.snapshot_id,
    created_at: input.created_at.toISOString(),
    total_events: input.entries.length,
    total_size_bytes,
    calendars: [...input.calendars],
    entries: [...input.entries],
  };
}
