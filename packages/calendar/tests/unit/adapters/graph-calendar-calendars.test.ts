import 'reflect-metadata';

import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { ListingIncompleteError } from '@wisecom/atlas-types';
import { stub_graph_client, type GraphCall } from '@wisecom/atlas-types/testing/stub-graph-client';

import { create_calendar, list_calendars } from '@/adapters/graph-calendar-calendars';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const CALENDARS = `/users/${MAILBOX}/calendars?$select=id,name,isDefaultCalendar,canEdit&$count=true`;

function client_for(route: (call: GraphCall) => unknown) {
  const graph = stub_graph_client(route);
  return { client: graph.client as unknown as Client, calls: graph.calls };
}

describe('list_calendars', () => {
  it('puts the default calendar first and reports read-only calendars as not editable', async () => {
    const { client } = client_for(() => ({
      value: [
        { id: 'cal-work', name: 'Work', canEdit: true },
        { id: 'cal-birthdays', name: 'Birthdays', canEdit: false },
        { id: 'cal-default', name: 'Calendar', isDefaultCalendar: true, canEdit: true },
        { id: 'cal-shared', name: 'Team' },
      ],
      '@odata.count': 4,
    }));

    const calendars = await list_calendars(client, MAILBOX);

    expect(calendars.map((c) => c.id)).toEqual([
      'cal-default',
      'cal-work',
      'cal-birthdays',
      'cal-shared',
    ]);
    expect(calendars.find((c) => c.id === 'cal-birthdays')?.can_edit).toBe(false);
    expect(calendars.find((c) => c.id === 'cal-shared')?.can_edit).toBe(false);
    expect(calendars.find((c) => c.id === 'cal-default')).toEqual({
      id: 'cal-default',
      display_name: 'Calendar',
      is_default: true,
      can_edit: true,
    });
  });

  it('follows nextLink pages and asks for the fields the mapping needs', async () => {
    const next = `/users/${MAILBOX}/calendars?$skip=1`;
    const { client, calls } = client_for((call) =>
      call.url === next
        ? { value: [{ id: 'cal-2', name: 'Two', canEdit: true }], '@odata.count': 2 }
        : {
            value: [{ id: 'cal-1', name: 'One', canEdit: true }],
            '@odata.count': 2,
            '@odata.nextLink': next,
          },
    );

    const calendars = await list_calendars(client, MAILBOX);

    expect(calendars.map((c) => c.id)).toEqual(['cal-1', 'cal-2']);
    expect(calls[0]!.url).toBe(CALENDARS);
  });

  it('refuses a listing that ends after its first page with fewer calendars than Graph counted', async () => {
    const { client } = client_for(() => ({
      value: [{ id: 'cal-1', name: 'One', canEdit: true }],
      '@odata.count': 3,
    }));

    const listing = list_calendars(client, MAILBOX);

    await expect(listing).rejects.toBeInstanceOf(ListingIncompleteError);
    await expect(listing).rejects.toMatchObject({
      code: 'ATLAS_LISTING_INCOMPLETE',
      listing: 'calendars',
      listed_count: 1,
      reported_count: 3,
    });
  });

  it('accepts a listing whose pages carry no count, since it cannot be checked', async () => {
    const { client } = client_for(() => ({ value: [{ id: 'cal-1', name: 'One', canEdit: true }] }));

    await expect(list_calendars(client, MAILBOX)).resolves.toHaveLength(1);
  });
});

describe('create_calendar', () => {
  it('posts the name and returns a writable, non-default calendar with the new id', async () => {
    const { client, calls } = client_for(() => ({ id: 'cal-new' }));

    const created = await create_calendar(client, MAILBOX, 'Restored');

    expect(calls[0]).toMatchObject({
      method: 'post',
      url: `/users/${MAILBOX}/calendars`,
      body: { name: 'Restored' },
    });
    expect(created).toEqual({
      id: 'cal-new',
      display_name: 'Restored',
      is_default: false,
      can_edit: true,
    });
  });

  it('fails when Graph returns no calendar id', async () => {
    const { client } = client_for(() => ({}));

    await expect(create_calendar(client, MAILBOX, 'Restored')).rejects.toThrow('no id');
  });
});
