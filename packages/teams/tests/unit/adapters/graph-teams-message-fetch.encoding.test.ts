import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import { fetch_message_delta, list_channel_messages } from '@/adapters/graph-teams-message-fetch';

const TEAM = 'team/1';
const CHANNEL = '19:abc@thread.tacv2';
const CHANNEL_PATH = '/teams/team%2F1/channels/19%3Aabc%40thread.tacv2';

/** A stub client answering with an empty page that has a delta link, so reads complete. */
function empty_client() {
  const stub = stub_graph_client(() => ({ value: [], '@odata.deltaLink': 'delta-token' }));
  return { client: stub.client as unknown as Client, calls: stub.calls };
}

describe('fetch_message_delta path encoding', () => {
  it('encodes the team and channel ids in the initial delta start URL', async () => {
    const { client, calls } = empty_client();

    await fetch_message_delta(client, TEAM, CHANNEL, undefined);

    expect(calls.map((call) => call.url)).toEqual([
      `${CHANNEL_PATH}/messages/delta?$top=50&$expand=replies`,
    ]);
  });
});

describe('list_channel_messages path encoding', () => {
  it('encodes the team and channel ids in the /messages path', async () => {
    const { client, calls } = empty_client();

    await list_channel_messages(client, TEAM, CHANNEL);

    expect(calls.map((call) => call.url)).toEqual([
      `${CHANNEL_PATH}/messages?$top=50&$expand=replies`,
    ]);
  });
});
