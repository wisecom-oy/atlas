import 'reflect-metadata';

import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { ListingIncompleteError } from '@wisecom/atlas-types';
import { stub_graph_client, type GraphCall } from '@wisecom/atlas-types/testing/stub-graph-client';

import { list_calendars } from '@/adapters/graph-calendar-calendars';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const PAGE_2 = 'https://graph.example.com/calendars-page-2';

/** Serves two calendar pages, the second repeating the first page's calendar. */
function repeating_listing(reported_count: number) {
  const graph = stub_graph_client((call: GraphCall) =>
    call.url === PAGE_2
      ? {
          value: [
            { id: 'cal-work', name: 'Work', canEdit: true },
            { id: 'cal-team', name: 'Team', canEdit: true },
          ],
          '@odata.count': reported_count,
        }
      : {
          value: [
            { id: 'cal-default', name: 'Calendar', isDefaultCalendar: true, canEdit: true },
            { id: 'cal-work', name: 'Work', canEdit: true },
          ],
          '@odata.count': reported_count,
          '@odata.nextLink': PAGE_2,
        },
  );
  return graph.client as unknown as Client;
}

describe('list_calendars with a calendar Graph lists twice (#964)', () => {
  it('returns the calendar once, after its repeat made up the four calendars Graph counted', async () => {
    const calendars = await list_calendars(repeating_listing(4), MAILBOX);

    expect(calendars.map((calendar) => calendar.id)).toEqual([
      'cal-default',
      'cal-work',
      'cal-team',
    ]);
  });

  it('keeps the first copy when the copies differ', async () => {
    const graph = stub_graph_client(() => ({
      value: [
        { id: 'cal-work', name: 'Work', canEdit: true },
        { id: 'cal-work', name: 'Renamed', canEdit: false },
      ],
      '@odata.count': 2,
    }));

    const calendars = await list_calendars(graph.client as unknown as Client, MAILBOX);

    expect(calendars).toEqual([
      { id: 'cal-work', display_name: 'Work', is_default: false, can_edit: true },
    ]);
  });

  it('compares the raw count, repeat included, when the listing falls short', async () => {
    const listing = list_calendars(repeating_listing(5), MAILBOX);

    await expect(listing).rejects.toBeInstanceOf(ListingIncompleteError);
    await expect(listing).rejects.toMatchObject({ listed_count: 4, reported_count: 5 });
  });
});
