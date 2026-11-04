import type { Client } from '@microsoft/microsoft-graph-client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { read_all_pages } from '@/adapters/graph-teams-request';
import { fetch_message_delta, list_channel_messages } from '@/adapters/graph-teams-message-fetch';

vi.mock('@/adapters/graph-teams-request', () => ({
  read_all_pages: vi.fn(),
}));

const CLIENT = {} as Client;
const TEAM = '00000000-0000-0000-0000-000000000001';
const CHANNEL = 'channel-1';
const EXPANDED_QUERY = '$top=50&$expand=replies';

function page(
  items: unknown[],
  delta_link?: string,
): { items: unknown[]; delta_link: string | undefined } {
  return { items, delta_link };
}

describe('fetch_message_delta', () => {
  const read = read_all_pages as unknown as Mock;

  beforeEach(() => {
    read.mockReset();
  });

  it('starts a full read with a page size of 50 and inline replies', async () => {
    read.mockResolvedValueOnce(page([], 'delta-link'));

    await fetch_message_delta(CLIENT, TEAM, CHANNEL, undefined);

    expect(read).toHaveBeenCalledWith(
      CLIENT,
      `/teams/${TEAM}/channels/${CHANNEL}/messages/delta?${EXPANDED_QUERY}`,
    );
  });

  it('resumes from the stored link without rebuilding the query', async () => {
    read.mockResolvedValueOnce(page([], 'delta-link-2'));

    await fetch_message_delta(CLIENT, TEAM, CHANNEL, 'stored-link');

    expect(read).toHaveBeenCalledWith(CLIENT, 'stored-link');
  });

  it('throws when Graph ends the read without a delta link', async () => {
    read.mockResolvedValueOnce(page([]));

    await expect(fetch_message_delta(CLIENT, TEAM, CHANNEL, undefined)).rejects.toThrow(
      'without a delta link',
    );
  });

  it('marks a message with @removed as deleted and carries no removal marker into the root', async () => {
    read.mockResolvedValueOnce(
      page([{ id: 'root-1', '@removed': { reason: 'softDelete' } }], 'delta-link'),
    );

    const { roots } = await fetch_message_delta(CLIENT, TEAM, CHANNEL, undefined);

    expect(roots).toEqual([{ root: { id: 'root-1' }, deleted: true, replies: undefined }]);
  });

  it('marks a message with a string deletedDateTime as deleted and keeps that timestamp', async () => {
    read.mockResolvedValueOnce(
      page([{ id: 'root-1', deletedDateTime: '2025-01-02T00:00:00Z' }], 'delta-link'),
    );

    const { roots } = await fetch_message_delta(CLIENT, TEAM, CHANNEL, undefined);

    expect(roots[0]?.deleted).toBe(true);
    expect(roots[0]?.root.deletedDateTime).toBe('2025-01-02T00:00:00Z');
  });

  it('does not mark a message with a null deletedDateTime as deleted', async () => {
    read.mockResolvedValueOnce(page([{ id: 'root-1', deletedDateTime: null }], 'delta-link'));

    const { roots } = await fetch_message_delta(CLIENT, TEAM, CHANNEL, undefined);

    expect(roots[0]?.deleted).toBe(false);
  });

  it('inlines replies when Graph returned them with no nextLink', async () => {
    const replies = [{ id: 'reply-1' }];
    read.mockResolvedValueOnce(page([{ id: 'root-1', replies }], 'delta-link'));

    const { roots } = await fetch_message_delta(CLIENT, TEAM, CHANNEL, undefined);

    expect(roots[0]?.replies).toEqual(replies);
    expect(roots[0]?.root).not.toHaveProperty('replies');
  });

  it('leaves replies undefined when Graph truncated them with a nextLink', async () => {
    read.mockResolvedValueOnce(
      page(
        [
          {
            id: 'root-1',
            replies: [{ id: 'reply-1' }],
            'replies@odata.nextLink': 'https://graph.example.test/next',
          },
        ],
        'delta-link',
      ),
    );

    const { roots } = await fetch_message_delta(CLIENT, TEAM, CHANNEL, undefined);

    expect(roots[0]?.replies).toBeUndefined();
    expect(roots[0]?.root).not.toHaveProperty('replies@odata.nextLink');
  });

  it('leaves replies undefined when the root has no replies array', async () => {
    read.mockResolvedValueOnce(page([{ id: 'root-1' }], 'delta-link'));

    const { roots } = await fetch_message_delta(CLIENT, TEAM, CHANNEL, undefined);

    expect(roots[0]?.replies).toBeUndefined();
  });
});

describe('list_channel_messages', () => {
  const read = read_all_pages as unknown as Mock;

  beforeEach(() => {
    read.mockReset();
  });

  it('reads every root with /messages, a page size of 50, and inline replies', async () => {
    read.mockResolvedValueOnce(page([{ id: 'root-1' }]));

    const roots = await list_channel_messages(CLIENT, TEAM, CHANNEL);

    expect(read).toHaveBeenCalledWith(
      CLIENT,
      `/teams/${TEAM}/channels/${CHANNEL}/messages?${EXPANDED_QUERY}`,
    );
    expect(roots).toEqual([{ root: { id: 'root-1' }, deleted: false, replies: undefined }]);
  });
});
