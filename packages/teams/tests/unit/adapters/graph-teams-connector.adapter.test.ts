import type { Client } from '@microsoft/microsoft-graph-client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as graph_request from '@/adapters/graph-teams-request';
import { read_all_pages } from '@/adapters/graph-teams-request';
import { GraphTeamsConnector } from '@/adapters/graph-teams-connector.adapter';
import { logger } from '@wisecom/atlas-core/utils/logger';

vi.mock('@/adapters/graph-teams-request', async (import_original) => ({
  ...(await import_original<typeof graph_request>()),
  read_all_pages: vi.fn(),
}));

describe('GraphTeamsConnector.list_channels', () => {
  const read = read_all_pages as unknown as Mock;

  beforeEach(() => {
    read.mockReset();
  });

  it('skips channels Graph returns without a usable id, and warns how many', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    read.mockResolvedValueOnce({
      items: [{ displayName: 'no id' }, { id: '' }, { id: 'channel-1', displayName: 'General' }],
    });

    const channels = await new GraphTeamsConnector({} as Client).list_channels(
      'tenant-1',
      '00000000-0000-0000-0000-000000000001',
    );

    expect(channels).toEqual([{ id: 'channel-1', displayName: 'General' }]);
    expect(warn).toHaveBeenCalledWith('Skipped 2 channel(s) that Graph returned without an id');
    warn.mockRestore();
  });

  it('returns every channel and warns nothing when each has an id', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    read.mockResolvedValueOnce({ items: [{ id: 'channel-1' }, { id: 'channel-2' }] });

    const channels = await new GraphTeamsConnector({} as Client).list_channels(
      'tenant-1',
      '00000000-0000-0000-0000-000000000001',
    );

    expect(channels.map((channel) => channel.id)).toEqual(['channel-1', 'channel-2']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('GraphTeamsConnector.list_channel_shared_teams', () => {
  const read = read_all_pages as unknown as Mock;

  beforeEach(() => {
    read.mockReset();
  });

  it('reads every page of the channel sharedWithTeams list', async () => {
    const client = {} as Client;
    read.mockResolvedValueOnce({
      items: [
        { id: '00000000-0000-0000-0000-000000000003' },
        { id: '00000000-0000-0000-0000-000000000004' },
      ],
    });

    const teams = await new GraphTeamsConnector(client).list_channel_shared_teams(
      'tenant-1',
      '00000000-0000-0000-0000-000000000001',
      'channel-1',
    );

    expect(read).toHaveBeenCalledWith(
      client,
      '/teams/00000000-0000-0000-0000-000000000001/channels/channel-1/sharedWithTeams',
    );
    expect(teams).toEqual([
      { id: '00000000-0000-0000-0000-000000000003' },
      { id: '00000000-0000-0000-0000-000000000004' },
    ]);
  });
});
