import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import {
  download_hosted_content,
  list_hosted_contents,
  list_replies,
} from '@/adapters/graph-teams-thread-fetch';

const TEAM = 'team/1';
const CHANNEL = '19:abc@thread.tacv2';
const ROOT = 'root/1';
const REPLY = 'reply/1';
const HOSTED = 'hosted+1';

const ROOT_PATH = '/teams/team%2F1/channels/19%3Aabc%40thread.tacv2/messages/root%2F1';

/** A stub client answering with an empty page, so the paged reads complete. */
function empty_client() {
  const stub = stub_graph_client(() => ({ value: [] }));
  return { client: stub.client as unknown as Client, calls: stub.calls };
}

describe('list_replies path encoding', () => {
  it('encodes the team, channel, and root ids in the replies path', async () => {
    const { client, calls } = empty_client();

    await list_replies(client, TEAM, CHANNEL, ROOT);

    expect(calls.map((call) => call.url)).toEqual([`${ROOT_PATH}/replies?$top=50`]);
  });
});

describe('list_hosted_contents path encoding', () => {
  it('encodes the root message ids when the locator names no reply', async () => {
    const { client, calls } = empty_client();

    await list_hosted_contents(client, { team_id: TEAM, channel_id: CHANNEL, root_id: ROOT });

    expect(calls.map((call) => call.url)).toEqual([`${ROOT_PATH}/hostedContents`]);
  });

  it('encodes the reply id when the locator names a reply', async () => {
    const { client, calls } = empty_client();

    await list_hosted_contents(client, {
      team_id: TEAM,
      channel_id: CHANNEL,
      root_id: ROOT,
      reply_id: REPLY,
    });

    expect(calls.map((call) => call.url)).toEqual([
      `${ROOT_PATH}/replies/reply%2F1/hostedContents`,
    ]);
  });
});

describe('download_hosted_content path encoding', () => {
  it('encodes the hosted content id in the $value path', async () => {
    const urls: string[] = [];
    const client = {
      api: (url: string) => {
        urls.push(url);
        const response = {
          headers: { get: () => null },
          arrayBuffer: async () => new ArrayBuffer(0),
        };
        return { responseType: () => ({ get: async () => response }) };
      },
    } as unknown as Client;

    const locator = { team_id: TEAM, channel_id: CHANNEL, root_id: ROOT };
    await download_hosted_content(client, locator, HOSTED);

    expect(urls).toEqual([`${ROOT_PATH}/hostedContents/hosted%2B1/$value`]);
  });
});
