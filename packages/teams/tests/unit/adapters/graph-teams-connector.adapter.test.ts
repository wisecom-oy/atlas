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

describe('GraphTeamsConnector.list_teams', () => {
  const read = read_all_pages as unknown as Mock;

  beforeEach(() => {
    read.mockReset();
  });

  it('asks Graph to count the teams and returns them when the listing holds every one', async () => {
    const client = {} as Client;
    read.mockResolvedValueOnce({ items: [{ id: 'team-1' }, { id: 'team-2' }], reported_count: 2 });

    const teams = await new GraphTeamsConnector(client).list_teams('tenant-1');

    expect(read).toHaveBeenCalledWith(client, '/teams?$select=id,displayName&$count=true');
    expect(teams.map((team) => team.id)).toEqual(['team-1', 'team-2']);
  });

  it('refuses a team listing that ended with fewer teams than Graph counted', async () => {
    read.mockResolvedValueOnce({ items: [{ id: 'team-1' }], reported_count: 3 });

    await expect(
      new GraphTeamsConnector({} as Client).list_teams('tenant-1'),
    ).rejects.toMatchObject({
      code: 'ATLAS_LISTING_INCOMPLETE',
      listing: 'teams',
      listed_count: 1,
      reported_count: 3,
    });
  });
});

describe('GraphTeamsConnector.channel_exists', () => {
  function client_answering(answer: () => Promise<unknown>): { client: Client; urls: string[] } {
    const urls: string[] = [];
    const client = {
      api: (url: string) => {
        urls.push(url);
        return { get: answer };
      },
    } as unknown as Client;
    return { client, urls };
  }

  it('reads the channel by id and reports it present when Graph answers', async () => {
    const { client, urls } = client_answering(async () => ({ id: 'channel-1' }));

    const exists = await new GraphTeamsConnector(client).channel_exists(
      'tenant-1',
      'team-1',
      'channel-1',
    );

    expect(exists).toBe(true);
    expect(urls).toEqual(['/teams/team-1/channels/channel-1?$select=id']);
  });

  it('reports the channel gone only on a 404', async () => {
    const { client } = client_answering(async () => {
      throw Object.assign(new Error('Not found'), { statusCode: 404 });
    });

    await expect(
      new GraphTeamsConnector(client).channel_exists('tenant-1', 'team-1', 'channel-1'),
    ).resolves.toBe(false);
  });

  it('rethrows any other failure rather than guess that the channel is gone', async () => {
    const { client } = client_answering(async () => {
      throw Object.assign(new Error('Bad request'), { statusCode: 400 });
    });

    await expect(
      new GraphTeamsConnector(client).channel_exists('tenant-1', 'team-1', 'channel-1'),
    ).rejects.toThrow('Bad request');
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
