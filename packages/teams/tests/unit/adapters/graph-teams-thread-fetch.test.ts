import type { Client } from '@microsoft/microsoft-graph-client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { graph_teams_call, read_all_pages } from '@/adapters/graph-teams-request';
import {
  download_hosted_content,
  list_hosted_contents,
  list_replies,
} from '@/adapters/graph-teams-thread-fetch';

vi.mock('@/adapters/graph-teams-request', () => ({
  read_all_pages: vi.fn(),
  graph_teams_call: vi.fn(),
}));

const TEAM = 'team-1';
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

  beforeEach(() => {
    guarded.mockReset();
    guarded.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  it('downloads the raw bytes of one hosted content as a Buffer', async () => {
    const api = vi.fn((_url: string) => ({
      responseType: () => ({
        get: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    }));
    const client = { api } as unknown as Client;

    const bytes = await download_hosted_content(
      client,
      { team_id: TEAM, channel_id: CHANNEL, root_id: ROOT },
      'hosted-1',
    );

    expect(api).toHaveBeenCalledWith(
      `/teams/${TEAM}/channels/${CHANNEL}/messages/${ROOT}/hostedContents/hosted-1/$value`,
    );
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});
