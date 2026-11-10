import type { Client } from '@microsoft/microsoft-graph-client';
import type { GraphCalendar } from '@wisecom/atlas-types';
import {
  CALENDARS_READ,
  CALENDARS_READ_WRITE,
  CREATE_ONCE,
  collect_pages,
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

/** Lists the mailbox's calendars with the default calendar first. */
export async function list_calendars(client: Client, mailbox_id: string): Promise<GraphCalendar[]> {
  const payloads = await collect_pages<CalendarPayload>(
    client,
    `${mailbox_url(mailbox_id)}/calendars?$select=id,name,isDefaultCalendar,canEdit`,
    CALENDARS_READ,
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
