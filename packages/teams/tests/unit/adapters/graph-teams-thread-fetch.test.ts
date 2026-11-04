import type { Client } from '@microsoft/microsoft-graph-client';
import { ResponseType } from '@microsoft/microsoft-graph-client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as graph_request from '@/adapters/graph-teams-request';
import {
  graph_teams_call,
  INCLUDE_UNKNOWN_ENUM_HEADERS,
  read_all_pages,
} from '@/adapters/graph-teams-request';
import {
  download_hosted_content,
  list_hosted_contents,
  list_replies,
} from '@/adapters/graph-teams-thread-fetch';

vi.mock('@/adapters/graph-teams-request', async (import_original) => ({
  ...(await import_original<typeof graph_request>()),
  read_all_pages: vi.fn(),
  graph_teams_call: vi.fn(),
}));

const TEAM = '00000000-0000-0000-0000-000000000001';
const CHANNEL = 'channel-1';
const ROOT = 'root-1';

describe('list_replies', () => {
  const read = read_all_pages as unknown as Mock;

  beforeEach(() => {
    read.mockReset();
  });

  it('pages /replies with a page size of 50 so no reply list is silently truncated', async () => {
    read.mockResolvedValueOnce({ items: [{ id: 'reply-1' }] });

    const replies = await list_replies({} as Client, TEAM, CHANNEL, ROOT);

    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      `/teams/${TEAM}/channels/${CHANNEL}/messages/${ROOT}/replies?$top=50`,
      INCLUDE_UNKNOWN_ENUM_HEADERS,
    );
    expect(replies).toEqual([{ id: 'reply-1' }]);
  });
});

describe('list_hosted_contents', () => {
  const read = read_all_pages as unknown as Mock;

  beforeEach(() => {
    read.mockReset();
    read.mockResolvedValue({ items: [] });
  });

  it("lists a root message's hosted contents when the locator names no reply", async () => {
    await list_hosted_contents({} as Client, {
      team_id: TEAM,
      channel_id: CHANNEL,
      root_id: ROOT,
    });

    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      `/teams/${TEAM}/channels/${CHANNEL}/messages/${ROOT}/hostedContents`,
    );
  });

  it("lists a reply's hosted contents when the locator names one", async () => {
    await list_hosted_contents({} as Client, {
      team_id: TEAM,
      channel_id: CHANNEL,
      root_id: ROOT,
      reply_id: 'reply-1',
    });

    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      `/teams/${TEAM}/channels/${CHANNEL}/messages/${ROOT}/replies/reply-1/hostedContents`,
    );
  });
});

describe('download_hosted_content', () => {
  const guarded = graph_teams_call as unknown as Mock;
  const locator = { team_id: TEAM, channel_id: CHANNEL, root_id: ROOT };

  beforeEach(() => {
    guarded.mockReset();
    guarded.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  /** A client whose `$value` request answers with the given bytes and response headers. */
  function client_answering(bytes: number[], headers: Record<string, string>, status = 200) {
    const get = vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name] ?? null },
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
      json: async () => ({ error: { code: 'NotFound', message: 'not found' } }),
    }));
    const response_type = vi.fn(() => ({ get }));
    const api = vi.fn((_url: string) => ({ responseType: response_type }));
    return { client: { api } as unknown as Client, api, response_type };
  }

  it('returns the raw bytes and the Content-Type Graph sent with them', async () => {
    const { client, api, response_type } = client_answering([1, 2, 3], {
      'content-type': 'image/png',
    });

    const hosted = await download_hosted_content(client, locator, 'hosted-1');

    expect(api).toHaveBeenCalledWith(
      `/teams/${TEAM}/channels/${CHANNEL}/messages/${ROOT}/hostedContents/hosted-1/$value`,
    );
    expect(response_type).toHaveBeenCalledWith(ResponseType.RAW);
    expect(Buffer.isBuffer(hosted.bytes)).toBe(true);
    expect([...hosted.bytes]).toEqual([1, 2, 3]);
    expect(hosted.content_type).toBe('image/png');
  });

  it('leaves content_type undefined when the response has no Content-Type', async () => {
    const { client } = client_answering([9], {});

    const hosted = await download_hosted_content(client, locator, 'hosted-1');

    expect(hosted.content_type).toBeUndefined();
  });

  it('throws a Graph error carrying the status instead of storing an error body', async () => {
    const { client } = client_answering([], { 'content-type': 'application/json' }, 404);

    await expect(download_hosted_content(client, locator, 'hosted-1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('does not route a 403 through the Teams AuthError mapping (S6)', async () => {
    const { client } = client_answering([], { 'content-type': 'application/json' }, 403);

    await expect(download_hosted_content(client, locator, 'hosted-1')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(guarded).not.toHaveBeenCalled();
  });
});
