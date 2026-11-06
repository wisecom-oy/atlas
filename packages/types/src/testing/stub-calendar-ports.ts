import type { CalendarDeltaCursor, CalendarSnapshotManifest } from '@/domain/calendar/manifest';
import type {
  CalendarConnector,
  CalendarEventDelta,
  EventAttachmentUpload,
  GraphCalendar,
  GraphEventAttachment,
  GraphEventPayload,
} from '@/ports/calendar/connector.port';
import type {
  CalendarDeltaCursorRepository,
  CalendarManifestRepository,
} from '@/ports/calendar/repository.port';

/**
 * Failure injection. Each hook returns the error to throw for that call, or undefined to let it
 * succeed. Hooks see the same arguments the connector receives.
 */
export interface CalendarHooks {
  readonly delta?: (calendar_id: string, delta_link: string | undefined) => Error | undefined;
  readonly series_master?: (event_id: string, time_zone: string) => Error | undefined;
  readonly attachment_content?: (attachment_id: string) => Error | undefined;
  readonly create_calendar?: (name: string) => Error | undefined;
  readonly list_events?: (calendar_id: string) => Error | undefined;
  readonly create_event?: (payload: Readonly<Record<string, unknown>>) => Error | undefined;
  readonly update_event?: (
    event_id: string,
    patch: Readonly<Record<string, unknown>>,
  ) => Error | undefined;
  readonly delete_occurrence?: (occurrence_id: string) => Error | undefined;
  readonly upload_attachment?: (attachment: EventAttachmentUpload) => Error | undefined;
}

/** Mutable script for the fake connector: calendars, deltas, and the data each read returns. */
export interface CalendarScript {
  calendars: GraphCalendar[];
  /** Delta responses keyed by calendar id. An unscripted calendar's delta call throws. */
  deltas: Record<string, CalendarEventDelta>;
  /** Series master payloads keyed by event id, as returned by `fetch_series_master`. */
  series_masters: Record<string, GraphEventPayload>;
  /** Attachment listings keyed by event id. */
  attachments: Record<string, GraphEventAttachment[]>;
  /** File bytes keyed by attachment id. */
  attachment_bytes: Record<string, Uint8Array>;
  /** Events already in a calendar, keyed by calendar id, as `list_calendar_events` returns them. */
  target_events: Record<string, GraphEventPayload[]>;
  /** Occurrences returned by `list_series_instances`, keyed by series master id. */
  instances: Record<string, GraphEventPayload[]>;
  hooks: CalendarHooks;
}

/** One recorded delta read: which calendar, and the link it was asked to resume from. */
export interface DeltaCall {
  readonly calendar_id: string;
  readonly delta_link: string | undefined;
}

/** Every write and read the restore and backup paths made, in call order. */
export interface CalendarCalls {
  readonly delta: DeltaCall[];
  readonly series_master: { readonly event_id: string; readonly time_zone: string }[];
  readonly listed_events: string[];
  readonly created_calendars: string[];
  readonly created_events: {
    readonly event_id: string;
    readonly calendar_id: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }[];
  readonly patches: {
    readonly event_id: string;
    readonly patch: Readonly<Record<string, unknown>>;
  }[];
  readonly instance_queries: { readonly series_id: string; readonly window: InstanceWindow }[];
  readonly deleted_occurrences: string[];
  readonly uploads: { readonly event_id: string; readonly attachment: EventAttachmentUpload }[];
}

export interface InstanceWindow {
  readonly start: string;
  readonly end: string;
  readonly time_zone: string;
}

export interface FakeCalendarConnector {
  readonly connector: CalendarConnector;
  readonly script: CalendarScript;
  readonly calls: CalendarCalls;
}

/** A calendar record. Default calendars are the target of the default-calendar mapping. */
export function calendar(
  id: string,
  display_name: string,
  flags: { is_default?: boolean; can_edit?: boolean } = {},
): GraphCalendar {
  return {
    id,
    display_name,
    is_default: flags.is_default ?? false,
    can_edit: flags.can_edit ?? true,
  };
}

/** Default mailbox: a writable default calendar and one writable shared-named calendar. */
export function default_calendars(): GraphCalendar[] {
  return [calendar('cal-default', 'Calendar', { is_default: true }), calendar('cal-work', 'Work')];
}

/** A single-instance event with example.com-free, deterministic fields; override any with `fields`. */
export function calendar_event(
  id: string,
  fields: Readonly<Record<string, unknown>> = {},
): GraphEventPayload {
  return {
    id,
    type: 'singleInstance',
    subject: `Event ${id}`,
    iCalUId: `uid-${id}`,
    start: { dateTime: '2030-01-01T09:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2030-01-01T10:00:00.0000000', timeZone: 'UTC' },
    isOrganizer: true,
    ...fields,
  };
}

/** A delta that reports the given upserts and removals, with a link to resume from. */
export function delta_of(
  delta_link: string,
  upserted: GraphEventPayload[] = [],
  removed_ids: string[] = [],
  reset = false,
): CalendarEventDelta {
  return { upserted, removed_ids, delta_link, reset };
}

function no_script(what: string): never {
  throw new Error(`${what} not scripted`);
}

/** Scriptable connector. Reads return what the script holds; writes are recorded and get fresh ids. */
export function fake_calendar_connector(): FakeCalendarConnector {
  const script: CalendarScript = {
    calendars: default_calendars(),
    deltas: {},
    series_masters: {},
    attachments: {},
    attachment_bytes: {},
    target_events: {},
    instances: {},
    hooks: {},
  };
  const calls: CalendarCalls = {
    delta: [],
    series_master: [],
    listed_events: [],
    created_calendars: [],
    created_events: [],
    patches: [],
    instance_queries: [],
    deleted_occurrences: [],
    uploads: [],
  };
  const hook = <A extends unknown[]>(
    fn: ((...args: A) => Error | undefined) | undefined,
    ...args: A
  ) => {
    const error = fn?.(...args);
    if (error !== undefined) throw error;
  };
  let next_id = 0;

  const connector: CalendarConnector = {
    list_calendars: async () => script.calendars,
    fetch_event_delta: async (_tenant, _mailbox, calendar_id, delta_link) => {
      calls.delta.push({ calendar_id, delta_link });
      hook(script.hooks.delta, calendar_id, delta_link);
      return script.deltas[calendar_id] ?? no_script(`delta for ${calendar_id}`);
    },
    fetch_series_master: async (_tenant, _mailbox, event_id, time_zone) => {
      calls.series_master.push({ event_id, time_zone });
      hook(script.hooks.series_master, event_id, time_zone);
      return script.series_masters[event_id] ?? no_script(`series master ${event_id}`);
    },
    list_event_attachments: async (_tenant, _mailbox, event_id) =>
      script.attachments[event_id] ?? [],
    fetch_attachment_content: async (_tenant, _mailbox, _event_id, attachment_id) => {
      hook(script.hooks.attachment_content, attachment_id);
      return script.attachment_bytes[attachment_id] ?? no_script(`attachment ${attachment_id}`);
    },
    list_calendar_events: async (_tenant, _mailbox, calendar_id) => {
      calls.listed_events.push(calendar_id);
      hook(script.hooks.list_events, calendar_id);
      return script.target_events[calendar_id] ?? [];
    },
    create_calendar: async (_tenant, _mailbox, name) => {
      hook(script.hooks.create_calendar, name);
      calls.created_calendars.push(name);
      const created = calendar(`cal-new-${++next_id}`, name);
      script.calendars = [...script.calendars, created];
      return created;
    },
    create_event: async (_tenant, _mailbox, calendar_id, payload) => {
      hook(script.hooks.create_event, payload);
      const event_id = `evt-new-${++next_id}`;
      calls.created_events.push({ event_id, calendar_id, payload });
      return event_id;
    },
    list_series_instances: async (_tenant, _mailbox, series_id, window) => {
      calls.instance_queries.push({ series_id, window });
      return script.instances[series_id] ?? [];
    },
    update_event: async (_tenant, _mailbox, event_id, patch) => {
      hook(script.hooks.update_event, event_id, patch);
      calls.patches.push({ event_id, patch });
    },
    delete_occurrence: async (_tenant, _mailbox, occurrence_id) => {
      hook(script.hooks.delete_occurrence, occurrence_id);
      calls.deleted_occurrences.push(occurrence_id);
    },
    upload_event_attachment: async (_tenant, _mailbox, event_id, attachment) => {
      hook(script.hooks.upload_attachment, attachment);
      calls.uploads.push({ event_id, attachment });
    },
  };
  return { connector, script, calls };
}

/** Manifest repository that keeps every saved manifest in memory; latest is the last one saved. */
export interface MemoryCalendarManifests extends CalendarManifestRepository {
  readonly saved: CalendarSnapshotManifest[];
}

export function memory_calendar_manifests(
  initial: CalendarSnapshotManifest[] = [],
): MemoryCalendarManifests {
  const saved = [...initial];
  return {
    saved,
    save: async (_ctx, manifest) => {
      saved.push(manifest);
    },
    find_by_snapshot: async (_ctx, _mailbox, snapshot_id) =>
      saved.find((m) => m.snapshot_id === snapshot_id),
    find_latest_by_mailbox: async () => saved.at(-1),
    list_snapshots_by_mailbox: async () => [...saved].reverse(),
  };
}

/** Cursor repository that keeps every saved cursor in memory; latest is the last one saved. */
export interface MemoryCalendarCursors extends CalendarDeltaCursorRepository {
  readonly saved: CalendarDeltaCursor[];
}

export function memory_calendar_cursors(initial?: CalendarDeltaCursor): MemoryCalendarCursors {
  const saved: CalendarDeltaCursor[] = initial === undefined ? [] : [initial];
  return {
    saved,
    load: async () => saved.at(-1),
    save: async (_ctx, cursor) => {
      saved.push(cursor);
    },
  };
}
