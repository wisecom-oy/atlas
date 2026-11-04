import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import { GraphTeamsConnector } from '@/adapters/graph-teams-connector.adapter';

const TENANT = 'tenant-1';
const TEAM = 'team/1';
const CHANNEL = '19:abc@thread.tacv2';
const ENC_TEAM = 'team%2F1';
const ENC_CHANNEL = '19%3Aabc%40thread.tacv2';
const CHANNEL_PATH = `/teams/${ENC_TEAM}/channels/${ENC_CHANNEL}`;

interface EncodingCase {
  readonly name: string;
  readonly call: (connector: GraphTeamsConnector) => Promise<unknown>;
  readonly path: string;
}

const CASES: readonly EncodingCase[] = [
  {
    name: 'get_team',
    call: (c) => c.get_team(TENANT, TEAM),
    path: `/teams/${ENC_TEAM}`,
  },
  {
    name: 'list_team_members',
    call: (c) => c.list_team_members(TENANT, TEAM),
    path: `/teams/${ENC_TEAM}/members`,
  },
  {
    name: 'list_channels',
    call: (c) => c.list_channels(TENANT, TEAM),
    path: `/teams/${ENC_TEAM}/channels`,
  },
  {
    name: 'list_channel_members',
    call: (c) => c.list_channel_members(TENANT, TEAM, CHANNEL),
    path: `${CHANNEL_PATH}/members`,
  },
  {
    name: 'list_channel_tabs',
    call: (c) => c.list_channel_tabs(TENANT, TEAM, CHANNEL),
    path: `${CHANNEL_PATH}/tabs?$expand=teamsApp`,
  },
  {
    name: 'list_channel_shared_teams',
    call: (c) => c.list_channel_shared_teams(TENANT, TEAM, CHANNEL),
    path: `${CHANNEL_PATH}/sharedWithTeams`,
  },
  {
    name: 'get_channel_files_folder',
    call: (c) => c.get_channel_files_folder(TENANT, TEAM, CHANNEL),
    path: `${CHANNEL_PATH}/filesFolder`,
  },
  {
    name: 'fetch_message_delta',
    call: (c) => c.fetch_message_delta(TENANT, TEAM, CHANNEL, undefined),
    path: `${CHANNEL_PATH}/messages/delta?$top=50&$expand=replies`,
  },
  {
    name: 'list_channel_messages',
    call: (c) => c.list_channel_messages(TENANT, TEAM, CHANNEL),
    path: `${CHANNEL_PATH}/messages?$top=50&$expand=replies`,
  },
];

describe('GraphTeamsConnector path encoding', () => {
  it.each(CASES)('$name encodes its ids in the request path', async ({ call, path }) => {
    // An empty page with a delta link satisfies every method, including the delta read.
    const stub = stub_graph_client(() => ({ value: [], '@odata.deltaLink': 'delta-token' }));
    const connector = new GraphTeamsConnector(stub.client as unknown as Client);

    await call(connector);

    expect(stub.calls.map((request) => request.url)).toEqual([path]);
  });
});
