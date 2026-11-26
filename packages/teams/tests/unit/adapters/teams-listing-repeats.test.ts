import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { ListingIncompleteError } from '@wisecom/atlas-types';
import { stub_graph_client, type GraphCall } from '@wisecom/atlas-types/testing/stub-graph-client';
import { GraphTeamsConnector } from '@/adapters/graph-teams-connector.adapter';

const TENANT = 'tenant-1';
const TEAM = '00000000-0000-0000-0000-000000000001';
const PAGE_2 = 'https://graph.example.com/page-2';

/** A connector over two pages, the second repeating an item of the first. */
function two_page_connector(
  first: readonly Record<string, unknown>[],
  second: readonly Record<string, unknown>[],
  reported_count?: number,
): GraphTeamsConnector {
  const count = reported_count === undefined ? {} : { '@odata.count': reported_count };
  const graph = stub_graph_client((call: GraphCall) =>
    call.url === PAGE_2
      ? { value: second, ...count }
      : { value: first, ...count, '@odata.nextLink': PAGE_2 },
  );
  return new GraphTeamsConnector(graph.client as unknown as Client);
}

describe('GraphTeamsConnector.list_teams with a team Graph lists twice (#964)', () => {
  it('returns the team once, so --all backs it up once', async () => {
    const connector = two_page_connector(
      [{ id: 'team-1', displayName: 'One' }],
      [
        { id: 'team-1', displayName: 'One' },
        { id: 'team-2', displayName: 'Two' },
      ],
      3,
    );

    const teams = await connector.list_teams(TENANT);

    expect(teams).toEqual([
      { id: 'team-1', displayName: 'One' },
      { id: 'team-2', displayName: 'Two' },
    ]);
  });

  it('counts the repeat toward @odata.count, so a short listing still fails', async () => {
    const connector = two_page_connector(
      [{ id: 'team-1' }],
      [{ id: 'team-1' }, { id: 'team-2' }],
      4,
    );

    const listing = connector.list_teams(TENANT);

    await expect(listing).rejects.toBeInstanceOf(ListingIncompleteError);
    await expect(listing).rejects.toMatchObject({
      listing: 'teams',
      listed_count: 3,
      reported_count: 4,
    });
  });
});

describe('GraphTeamsConnector.list_channels with a channel Graph lists twice (#964)', () => {
  it('returns the first copy once, so one worker reads it and it gets one index entry', async () => {
    const connector = two_page_connector(
      [
        { id: 'channel-1', displayName: 'General' },
        { id: 'channel-2', displayName: 'Projects' },
      ],
      [
        { id: 'channel-1', displayName: 'General (repeat)' },
        { id: 'channel-3', displayName: 'Support' },
      ],
    );

    const channels = await connector.list_channels(TENANT, TEAM);

    expect(channels).toEqual([
      { id: 'channel-1', displayName: 'General' },
      { id: 'channel-2', displayName: 'Projects' },
      { id: 'channel-3', displayName: 'Support' },
    ]);
  });

  it('drops a repeat within one page as well', async () => {
    const graph = stub_graph_client(() => ({
      value: [{ id: 'channel-1' }, { id: 'channel-1' }],
    }));

    const channels = await new GraphTeamsConnector(graph.client as unknown as Client).list_channels(
      TENANT,
      TEAM,
    );

    expect(channels).toEqual([{ id: 'channel-1' }]);
  });
});
