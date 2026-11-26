/**
 * The calendar listing that opens a Calendar backup, under the in-run confirmation rule (#864).
 *
 * `GET /users/{id}/calendars` was sent once. A transient 404 ended the run with exit `7` and a
 * transient 400 with an unclassified exit `1`. Both are read again now; a 404 that persists is
 * `NotFoundError` only when the mailbox's user answers 404 too, and every other persistent 4xx is
 * `GraphUnavailableError`. Licence and missing-grant answers keep their errors and are not repeated.
 */

import 'reflect-metadata';

import type { Client } from '@microsoft/microsoft-graph-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingGraphPermissionsError } from '@wisecom/atlas-m365-graph';
import {
  GraphUnavailableError,
  MailboxNotLicensedError,
  NotFoundError,
} from '@wisecom/atlas-types';
import {
  graph_error,
  stub_graph_client,
  type GraphCall,
} from '@wisecom/atlas-types/testing/stub-graph-client';

import { list_calendars } from '@/adapters/graph-calendar-calendars';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const CALENDARS = `/users/${MAILBOX}/calendars?$select=id,name,isDefaultCalendar,canEdit&$count=true`;
const USER = `/users/${MAILBOX}?$select=id`;
const LISTING = {
  value: [{ id: 'cal-default', name: 'Calendar', isDefaultCalendar: true, canEdit: true }],
  '@odata.count': 1,
};

/** A stub client that answers each url's nth call through `route`. */
function client_for(route: (url: string, count: number) => unknown) {
  const counts = new Map<string, number>();
  const graph = stub_graph_client((call: GraphCall) => {
    const count = (counts.get(call.url) ?? 0) + 1;
    counts.set(call.url, count);
    return route(call.url, count);
  });
  const urls = (): string[] => graph.calls.map((call) => call.url);
  return { client: graph.client as unknown as Client, urls };
}

/** Lists the calendars, advancing fake time through every wait; a failure comes back as `error`. */
async function list(client: Client): Promise<unknown> {
  const outcome = list_calendars(client, MAILBOX).catch((error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('list_calendars after a transient answer on the listing', () => {
  it.each([
    [404, 'ErrorItemNotFound'],
    [400, 'invalidRequest'],
    [503, 'serviceNotAvailable'],
  ])('lists the calendars when one %i clears on the next read', async (status, code) => {
    const { client, urls } = client_for((_url, count) => {
      if (count === 1) throw graph_error(status, code);
      return LISTING;
    });

    await expect(list(client)).resolves.toEqual([
      { id: 'cal-default', display_name: 'Calendar', is_default: true, can_edit: true },
    ]);
    expect(urls()).toEqual([CALENDARS, CALENDARS]);
  });

  it('reports a 404 that persists for a mailbox that exists as GraphUnavailableError', async () => {
    const { client } = client_for((url) => {
      if (url === USER) return { id: MAILBOX };
      throw graph_error(404, 'ErrorItemNotFound');
    });

    const { error } = (await list(client)) as { error: unknown };

    expect(error).toBeInstanceOf(GraphUnavailableError);
    expect(error).not.toBeInstanceOf(NotFoundError);
  });

  it('reports NotFoundError, within six requests, when the mailbox user is gone too', async () => {
    const { client, urls } = client_for(() => {
      throw graph_error(404, 'ErrorItemNotFound');
    });

    const { error } = (await list(client)) as { error: unknown };

    expect(error).toBeInstanceOf(NotFoundError);
    expect(urls()).toHaveLength(6);
  });

  it('classifies a 400 that persists as GraphUnavailableError rather than an unclassified error', async () => {
    const { client } = client_for(() => {
      throw graph_error(400, 'invalidRequest');
    });

    const { error } = (await list(client)) as { error: unknown };

    expect(error).toBeInstanceOf(GraphUnavailableError);
    expect(error).toMatchObject({ status_code: 400, graph_code: 'invalidRequest' });
  });

  it('keeps a 401 for the shared request path, reporting it with its status', async () => {
    const { client } = client_for(() => {
      throw graph_error(401, 'InvalidAuthenticationToken');
    });

    const { error } = (await list(client)) as { error: unknown };

    expect(error).toMatchObject({ statusCode: 401 });
  });

  it('reports a missing grant on the first read', async () => {
    const { client, urls } = client_for(() => {
      throw graph_error(403, 'ErrorAccessDenied');
    });

    const { error } = (await list(client)) as { error: unknown };

    expect(error).toBeInstanceOf(MissingGraphPermissionsError);
    expect((error as Error).message).toContain('Calendars.Read');
    expect(urls()).toEqual([CALENDARS]);
  });

  it.each([403, 404])(
    'reports MailboxNotEnabledForRESTAPI on a %i as an unlicensed mailbox, on the first read',
    async (status) => {
      const { client, urls } = client_for(() => {
        throw graph_error(status, 'MailboxNotEnabledForRESTAPI');
      });

      const { error } = (await list(client)) as { error: unknown };

      expect(error).toBeInstanceOf(MailboxNotLicensedError);
      expect(urls()).toEqual([CALENDARS]);
    },
  );
});
