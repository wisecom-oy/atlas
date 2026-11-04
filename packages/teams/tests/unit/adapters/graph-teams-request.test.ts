import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { AuthError } from '@wisecom/atlas-types';
import {
  graph_error,
  stub_graph_client,
  type GraphCall,
} from '@wisecom/atlas-types/testing/stub-graph-client';
import { graph_teams_call, read_all_pages } from '@/adapters/graph-teams-request';

const START = '/teams?$select=id,displayName';
const PAGE_2 = 'https://graph.example.test/v1.0/teams?$skiptoken=page-2';
const PAGE_3 = 'https://graph.example.test/v1.0/teams?$skiptoken=page-3';

/** A stub client answering each URL from `pages`; an Error value fails that page. */
function serve(pages: Record<string, unknown>): { client: Client; calls: GraphCall[] } {
  const stub = stub_graph_client(({ url }) => {
    if (!(url in pages)) throw new Error(`unexpected url ${url}`);
    const page = pages[url];
    if (page instanceof Error) throw page;
    return page;
  });
  return { client: stub.client as unknown as Client, calls: stub.calls };
}

describe('read_all_pages', () => {
  it('follows every nextLink across three pages and returns the items in order', async () => {
    const { client, calls } = serve({
      [START]: { value: [{ id: 'a' }, { id: 'b' }], '@odata.nextLink': PAGE_2 },
      [PAGE_2]: { value: [{ id: 'c' }], '@odata.nextLink': PAGE_3 },
      [PAGE_3]: { value: [{ id: 'd' }] },
    });

    const result = await read_all_pages(client, START);

    expect(calls.map((call) => call.url)).toEqual([START, PAGE_2, PAGE_3]);
    expect(result).toEqual({
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      delta_link: undefined,
    });
  });

  it('returns the delta link of the page that carries it', async () => {
    const { client } = serve({
      [START]: { value: [{ id: 'a' }], '@odata.nextLink': PAGE_2 },
      [PAGE_2]: { value: [{ id: 'b' }], '@odata.deltaLink': 'delta-token' },
    });

    const result = await read_all_pages(client, START);

    expect(result).toEqual({ items: [{ id: 'a' }, { id: 'b' }], delta_link: 'delta-token' });
  });

  it('maps a 403 on a later page to AuthError naming the Teams permission', async () => {
    const { client } = serve({
      [START]: { value: [{ id: 'a' }], '@odata.nextLink': PAGE_2 },
      [PAGE_2]: graph_error(403, 'ErrorAccessDenied', 'Access denied'),
    });

    const read = read_all_pages(client, START);

    await expect(read).rejects.toBeInstanceOf(AuthError);
    await expect(read).rejects.toThrow('Team.ReadBasic.All');
  });
});

describe('graph_teams_call', () => {
  it('maps a 403 to AuthError naming the Teams permission', async () => {
    const forbidden = graph_error(403, 'ErrorAccessDenied', 'Access denied');

    const call = graph_teams_call(() => Promise.reject(forbidden));

    await expect(call).rejects.toBeInstanceOf(AuthError);
    await expect(call).rejects.toThrow('ChannelMessage.Read.All');
    await expect(call).rejects.toMatchObject({ cause: forbidden });
  });

  it('rethrows a non-403 error unchanged', async () => {
    const missing = graph_error(404, 'ResourceNotFound', 'Not found');

    await expect(graph_teams_call(() => Promise.reject(missing))).rejects.toBe(missing);
  });

  it('returns the value of a successful call', async () => {
    await expect(graph_teams_call(async () => 'ok')).resolves.toBe('ok');
  });
});
