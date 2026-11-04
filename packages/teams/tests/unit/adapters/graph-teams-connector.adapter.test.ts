import type { Client } from '@microsoft/microsoft-graph-client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as graph_request from '@/adapters/graph-teams-request';
import { read_all_pages } from '@/adapters/graph-teams-request';
import { GraphTeamsConnector } from '@/adapters/graph-teams-connector.adapter';

vi.mock('@/adapters/graph-teams-request', async (import_original) => ({
  ...(await import_original<typeof graph_request>()),
  read_all_pages: vi.fn(),
}));

describe('GraphTeamsConnector.list_channel_shared_teams', () => {
  const read = read_all_pages as unknown as Mock;

  beforeEach(() => {
    read.mockReset();
  });

  it('reads every page of the channel sharedWithTeams list', async () => {
    const client = {} as Client;
    read.mockResolvedValueOnce({ items: [{ id: 'shared-team-1' }, { id: 'shared-team-2' }] });

    const teams = await new GraphTeamsConnector(client).list_channel_shared_teams(
      'tenant-1',
      'team-1',
      'channel-1',
    );

    expect(read).toHaveBeenCalledWith(client, '/teams/team-1/channels/channel-1/sharedWithTeams');
    expect(teams).toEqual([{ id: 'shared-team-1' }, { id: 'shared-team-2' }]);
  });
});
