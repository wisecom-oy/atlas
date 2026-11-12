import type { Client } from '@microsoft/microsoft-graph-client';
import { is_invalid_delta_error } from '@wisecom/atlas-m365-graph';
import type { CalendarEventDelta, GraphEventPayload } from '@wisecom/atlas-types';
import { CALENDARS_READ, get_json, mailbox_url } from '@/adapters/graph-calendar-requests';
import { append_all } from '@wisecom/atlas-core/utils/append-all';
import { logger } from '@wisecom/atlas-core/utils/logger';

type DeltaItem = GraphEventPayload & { readonly '@removed'?: unknown };

interface DeltaPage {
  readonly value?: DeltaItem[];
  readonly '@odata.nextLink'?: string;
  readonly '@odata.deltaLink'?: string;
}

/**
 * Event delta without `$select` returns only id, type, start and end. These are the v1.0 event
 * properties a restore needs; Graph carries the selection into the next and delta links.
 */
const EVENT_FIELDS = [
  'subject',
  'body',
  'start',
  'end',
  'isAllDay',
  'location',
  'locations',
  'attendees',
  'organizer',
  'recurrence',
  'type',
  'seriesMasterId',
  'showAs',
  'sensitivity',
  'importance',
  'categories',
  'reminderMinutesBeforeStart',
  'isReminderOn',
  'responseRequested',
  'responseStatus',
  'isOnlineMeeting',
  'onlineMeetingProvider',
  'onlineMeeting',
  'allowNewTimeProposals',
  'hideAttendees',
  'iCalUId',
  'isOrganizer',
  'isCancelled',
  'hasAttachments',
  'createdDateTime',
  'lastModifiedDateTime',
  'originalStartTimeZone',
  'originalEndTimeZone',
].join(',');

/** Reads one calendar's event changes; a rejected stored link re-reads the calendar in full. */
export async function fetch_calendar_delta(
  client: Client,
  mailbox_id: string,
  calendar_id: string,
  delta_link?: string,
): Promise<CalendarEventDelta> {
  const full_url = `${mailbox_url(mailbox_id)}/calendars/${encodeURIComponent(calendar_id)}/events/delta?$select=${EVENT_FIELDS}`;
  if (delta_link === undefined) return read_delta(client, full_url, false);
  try {
    return await read_delta(client, delta_link, false);
  } catch (err) {
    if (!is_invalid_delta_error(err)) throw err;
    return read_delta(client, full_url, true);
  }
}

/** Follows every delta page to the final delta link and splits upserts from removals. */
async function read_delta(
  client: Client,
  start_url: string,
  reset: boolean,
): Promise<CalendarEventDelta> {
  const items: DeltaItem[] = [];
  const seen = new Set<string>();
  let next: string | undefined = start_url;
  let delta_link: string | undefined;
  while (next !== undefined) {
    if (seen.has(next)) throw new Error('Calendar delta paging did not advance');
    seen.add(next);
    const page: DeltaPage = await get_json(client, next, CALENDARS_READ);
    append_all(items, page.value ?? []);
    next = page['@odata.nextLink'];
    delta_link = page['@odata.deltaLink'] ?? delta_link;
  }
  if (delta_link === undefined) throw new Error('Calendar delta response carried no deltaLink');
  // An event can appear more than once in one round (a series edited across pages, removed then
  // re-added); only its last appearance describes the calendar's current state.
  const last_by_id = new Map<string, DeltaItem>();
  let items_without_id = 0;
  for (const item of items) {
    if (typeof item.id !== 'string' || item.id === '') {
      items_without_id++;
      continue;
    }
    last_by_id.delete(item.id);
    last_by_id.set(item.id, item);
  }
  if (items_without_id > 0) {
    logger.warn(`Skipped ${items_without_id} event(s) that Graph returned without an id`);
  }
  const finals = [...last_by_id.values()];
  return {
    upserted: finals.filter((item) => !('@removed' in item)),
    removed_ids: finals.filter((item) => '@removed' in item).map((item) => item.id),
    delta_link,
    reset,
  };
}
