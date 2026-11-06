import 'reflect-metadata';

import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import {
  graph_error,
  stub_graph_client,
  type GraphCall,
} from '@wisecom/atlas-types/testing/stub-graph-client';

import {
  create_event,
  delete_occurrence,
  fetch_series_master,
  list_calendar_events,
  list_series_instances,
  update_event,
} from '@/adapters/graph-calendar-events';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const CALENDAR = 'cal-work';
const TIME_ZONE = 'Central Europe Standard Time';
const NEXT_PAGE = 'https://graph.example.com/page-2';

function client_for(route: (call: GraphCall) => unknown) {
  const graph = stub_graph_client(route, { record_headers: true });
  return { client: graph.client as unknown as Client, calls: graph.calls };
}

describe('fetch_series_master', () => {
  it('reads the master from the beta endpoint with the output time zone requested', async () => {
    const { client, calls } = client_for(() => ({ id: 'series-1', type: 'seriesMaster' }));

    await fetch_series_master(client, MAILBOX, 'series-1', TIME_ZONE);

    expect(calls[0]!.version).toBe('beta');
    expect(calls[0]!.url).toBe(`/users/${MAILBOX}/events/series-1?$expand=exceptionOccurrences`);
    expect(calls[0]!.headers?.Prefer).toContain(`outlook.timezone="${TIME_ZONE}"`);
  });

  it('reads every page of exception occurrences from beta and folds them into one list', async () => {
    const { client, calls } = client_for((call) => {
      if (call.url === NEXT_PAGE) return { value: [{ id: 'ex-2' }] };
      return {
        id: 'series-1',
        type: 'seriesMaster',
        exceptionOccurrences: [{ id: 'ex-1' }],
        'exceptionOccurrences@odata.nextLink': NEXT_PAGE,
      };
    });

    const master = await fetch_series_master(client, MAILBOX, 'series-1', TIME_ZONE);

    expect((master.exceptionOccurrences as { id: string }[]).map((e) => e.id)).toEqual([
      'ex-1',
      'ex-2',
    ]);
    expect(master).not.toHaveProperty('exceptionOccurrences@odata.nextLink');
    expect(calls[1]!.version).toBe('beta');
  });

  it('fails when Graph returns a master without an id', async () => {
    const { client } = client_for(() => ({ subject: 'no id here' }));

    await expect(fetch_series_master(client, MAILBOX, 'series-1', TIME_ZONE)).rejects.toThrow(
      'no id',
    );
  });
});

describe('list_calendar_events', () => {
  it('pages through the calendar and asks for the source-id tag on every event', async () => {
    const { client, calls } = client_for((call) => {
      if (call.url === NEXT_PAGE) return { value: [{ id: 'e2' }] };
      return { value: [{ id: 'e1' }], '@odata.nextLink': NEXT_PAGE };
    });

    const events = await list_calendar_events(client, MAILBOX, CALENDAR);

    expect(events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(decodeURIComponent(calls[0]!.url)).toContain(
      "id eq 'String {6f1d5a7e-3c2b-4f8e-9a41-0b7c2d9e5f13} Name AtlasSourceEventId'",
    );
  });
});

describe('create_event', () => {
  it('posts the payload unchanged and returns the new event id', async () => {
    const payload = { subject: 'Standup', start: { dateTime: '2030-01-01T09:00:00' } };
    const { client, calls } = client_for(() => ({ id: 'evt-9' }));

    const id = await create_event(client, MAILBOX, CALENDAR, payload);

    expect(id).toBe('evt-9');
    expect(calls[0]!.method).toBe('post');
    expect(calls[0]!.body).toEqual(payload);
  });

  it('reports a 403 as a missing Calendars.ReadWrite grant', async () => {
    const { client } = client_for(() => {
      throw graph_error(403, 'ErrorAccessDenied', 'Access is denied.');
    });

    const failure = await create_event(client, MAILBOX, CALENDAR, {}).catch((e) => e);

    expect(failure).toBeInstanceOf(AuthError);
    expect(failure.message).toContain('Calendars.ReadWrite');
  });

  it('reports an unlicensed mailbox as MailboxNotLicensedError, not as a missing grant', async () => {
    // Graph answers the licence fault with 403, the same status as a missing grant. The code is
    // what tells them apart, so the licence fault must not be read as a permission problem.
    const { client } = client_for(() => {
      throw graph_error(403, 'MailboxNotEnabledForRESTAPI', 'Mailbox not enabled for REST API.');
    });

    await expect(create_event(client, MAILBOX, CALENDAR, {})).rejects.toBeInstanceOf(
      MailboxNotLicensedError,
    );
  });
});

describe('update_event and delete_occurrence', () => {
  it('sends the patch as a PATCH to the event itself', async () => {
    const { client, calls } = client_for(() => ({}));

    await update_event(client, MAILBOX, 'evt-9', { subject: 'Renamed' });

    expect(calls[0]).toMatchObject({
      method: 'patch',
      url: `/users/${MAILBOX}/events/evt-9`,
      body: { subject: 'Renamed' },
    });
  });

  it('deletes the occurrence addressed by its own event id', async () => {
    const { client, calls } = client_for(() => ({}));

    await delete_occurrence(client, MAILBOX, 'occ-3');

    expect(calls[0]).toMatchObject({ method: 'delete', url: `/users/${MAILBOX}/events/occ-3` });
  });
});

describe('list_series_instances', () => {
  it('queries the window in the output time zone and pages through the instances', async () => {
    const { client, calls } = client_for((call) => {
      if (call.url === NEXT_PAGE) return { value: [{ id: 'inst-2' }] };
      return { value: [{ id: 'inst-1' }], '@odata.nextLink': NEXT_PAGE };
    });

    const instances = await list_series_instances(client, MAILBOX, 'series-1', {
      start: '2030-01-01T00:00:00',
      end: '2030-01-31T00:00:00',
      time_zone: TIME_ZONE,
    });

    expect(instances.map((i) => i.id)).toEqual(['inst-1', 'inst-2']);
    const query = new URL(calls[0]!.url, 'https://graph.example.com').searchParams;
    expect(query.get('startDateTime')).toBe('2030-01-01T00:00:00');
    expect(query.get('endDateTime')).toBe('2030-01-31T00:00:00');
    expect(calls[0]!.headers?.Prefer).toContain(`outlook.timezone="${TIME_ZONE}"`);
  });
});
