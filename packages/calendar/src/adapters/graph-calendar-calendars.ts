import type { Client } from '@microsoft/microsoft-graph-client';
import type { GraphCalendar } from '@wisecom/atlas-types';
import { read_owner_listing } from '@wisecom/atlas-m365-graph';
import {
  CALENDARS_READ,
  CALENDARS_READ_WRITE,
  CREATE_ONCE,
  collect_listing,
  graph_call,
  mailbox_url,
  string_field,
} from '@/adapters/graph-calendar-requests';

interface CalendarPayload {
  readonly id: string;
  readonly name: string;
  readonly isDefaultCalendar?: boolean;
  readonly canEdit?: boolean;
}

function to_calendar(payload: CalendarPayload): GraphCalendar {
  return {
    id: payload.id,
    display_name: payload.name,
    is_default: payload.isDefaultCalendar === true,
    can_edit: payload.canEdit === true,
  };
}

/**
 * Lists the mailbox's calendars with the default calendar first. A 404 or other unclassified 4xx
 * is read again before it is believed, since the listing decides whether the run happens (#864).
 *
 * @throws ListingIncompleteError when the pages hold fewer calendars than Graph counted.
 * @throws NotFoundError when the listing and the mailbox's user both answered 404 on every read.
 * @throws GraphUnavailableError when a 404 or another 4xx persisted for a mailbox that exists.
 */
export async function list_calendars(client: Client, mailbox_id: string): Promise<GraphCalendar[]> {
  const payloads = await read_owner_listing(
    client,
    { owner_id: mailbox_id, listing: 'calendars' },
    () =>
      collect_listing<CalendarPayload>(
        client,
        `${mailbox_url(mailbox_id)}/calendars?$select=id,name,isDefaultCalendar,canEdit`,
        CALENDARS_READ,
        'calendars',
      ),
  );
  const calendars = payloads.map(to_calendar);
  return [...calendars.filter((c) => c.is_default), ...calendars.filter((c) => !c.is_default)];
}

/** Creates a calendar in the mailbox. */
export async function create_calendar(
  client: Client,
  mailbox_id: string,
  name: string,
): Promise<GraphCalendar> {
  const created: unknown = await graph_call(
    CALENDARS_READ_WRITE,
    (signal) =>
      client
        .api(`${mailbox_url(mailbox_id)}/calendars`)
        .option('signal', signal)
        .post({ name }),
    CREATE_ONCE,
  );
  return { id: string_field(created, 'id'), display_name: name, is_default: false, can_edit: true };
}
