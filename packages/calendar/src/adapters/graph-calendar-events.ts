import type { Client } from '@microsoft/microsoft-graph-client';
import type { GraphEventPayload } from '@wisecom/atlas-types';
import {
  CALENDARS_READ,
  CALENDARS_READ_WRITE,
  CREATE_ONCE,
  collect_pages,
  get_json,
  graph_call,
  mailbox_url,
  prefer_header,
  string_field,
} from '@/adapters/graph-calendar-requests';
import { SOURCE_EVENT_PROPERTY_ID } from '@/services/shared/source-tag';

function event_url(mailbox_id: string, event_id: string): string {
  return `${mailbox_url(mailbox_id)}/events/${encodeURIComponent(event_id)}`;
}

/**
 * Reads a series master from Graph beta, the only version that expands `exceptionOccurrences` and
 * returns `cancelledOccurrences`. Selecting fields would also strip the expanded exceptions, so
 * the full object is read. Exception pages beyond the first are followed.
 */
export async function fetch_series_master(
  client: Client,
  mailbox_id: string,
  event_id: string,
  time_zone: string,
): Promise<GraphEventPayload> {
  const options = { time_zone, beta: true };
  const url = `${event_url(mailbox_id, event_id)}?$expand=exceptionOccurrences`;
  const master = await get_json<Record<string, unknown>>(client, url, CALENDARS_READ, options);
  const next = master['exceptionOccurrences@odata.nextLink'];
  if (typeof next === 'string') {
    const listed: unknown = master['exceptionOccurrences'];
    const first: unknown[] = Array.isArray(listed) ? listed : [];
    const rest = await collect_pages<unknown>(client, next, CALENDARS_READ, options);
    master['exceptionOccurrences'] = [...first, ...rest];
    delete master['exceptionOccurrences@odata.nextLink'];
  }
  return { ...master, id: string_field(master, 'id') };
}

/** Lists a calendar's single instances and series masters with the fields restore matches on. */
export async function list_calendar_events(
  client: Client,
  mailbox_id: string,
  calendar_id: string,
): Promise<GraphEventPayload[]> {
  const filter = encodeURIComponent(`id eq '${SOURCE_EVENT_PROPERTY_ID}'`);
  const url =
    `${mailbox_url(mailbox_id)}/calendars/${encodeURIComponent(calendar_id)}/events` +
    `?$select=iCalUId&$top=100&$expand=singleValueExtendedProperties($filter=${filter})`;
  return collect_pages<GraphEventPayload>(client, url, CALENDARS_READ);
}

/** Creates an event in a calendar and returns its immutable id. */
export async function create_event(
  client: Client,
  mailbox_id: string,
  calendar_id: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<string> {
  const url = `${mailbox_url(mailbox_id)}/calendars/${encodeURIComponent(calendar_id)}/events`;
  const created: unknown = await graph_call(
    CALENDARS_READ_WRITE,
    (signal) =>
      client.api(url).header('Prefer', prefer_header()).option('signal', signal).post(payload),
    CREATE_ONCE,
  );
  return string_field(created, 'id');
}

/** Lists a series' occurrences and exceptions inside a window, start and end in `time_zone`. */
export async function list_series_instances(
  client: Client,
  mailbox_id: string,
  series_master_id: string,
  window: { readonly start: string; readonly end: string; readonly time_zone: string },
): Promise<GraphEventPayload[]> {
  const query =
    `startDateTime=${encodeURIComponent(window.start)}&endDateTime=${encodeURIComponent(window.end)}` +
    '&$select=id,type,start,end,originalStart&$top=100';
  return collect_pages<GraphEventPayload>(
    client,
    `${event_url(mailbox_id, series_master_id)}/instances?${query}`,
    CALENDARS_READ,
    { time_zone: window.time_zone },
  );
}

/** Applies a partial update to an event or occurrence. */
export async function update_event(
  client: Client,
  mailbox_id: string,
  event_id: string,
  patch: Readonly<Record<string, unknown>>,
): Promise<void> {
  await graph_call(CALENDARS_READ_WRITE, () =>
    client.api(event_url(mailbox_id, event_id)).patch(patch),
  );
}

/** Removes one occurrence of a series created by this restore. */
export async function delete_occurrence(
  client: Client,
  mailbox_id: string,
  occurrence_id: string,
): Promise<void> {
  await graph_call(CALENDARS_READ_WRITE, () =>
    client.api(event_url(mailbox_id, occurrence_id)).delete(),
  );
}
