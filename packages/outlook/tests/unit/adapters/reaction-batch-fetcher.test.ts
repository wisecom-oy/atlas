import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@microsoft/microsoft-graph-client';
import { AuthError } from '@wisecom/atlas-types';
import { fetch_message_reaction_properties } from '@/adapters/graph-message-reaction-fetcher';

/**
 * Issue #513. Reactions were read with one `GET /messages/{id}` per message. They are now read
 * 20 per `$batch`, chained so Exchange runs them one at a time, and only unsettled reads are sent
 * again.
 */
interface SubRequest {
  readonly id: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly dependsOn?: string[];
}

type SubResponse = { status: number; headers?: Record<string, string>; body?: unknown };

const PREFER = 'IdType="ImmutableId"';
const LIKE = {
  id: 'String {41F28F13-83F4-4114-A584-EEDB5A6B0BFF} Name OwnerReactionType',
  value: 'like',
};

function ok(): SubResponse {
  return { status: 200, body: { id: 'x', singleValueExtendedProperties: [LIKE] } };
}

/** A Graph client whose `$batch` answers each sub-request with `answer(message_id, pass)`. */
function batch_client(answer: (message_id: string, pass: number) => SubResponse) {
  const sent: SubRequest[][] = [];
  const post = vi.fn(async (body: { requests: SubRequest[] }) => {
    const pass = sent.length;
    sent.push(body.requests);
    return {
      responses: body.requests.map((request) => {
        const message_id = decodeURIComponent(request.url.split('/messages/')[1]!.split('?')[0]!);
        return { id: request.id, ...answer(message_id, pass) };
      }),
    };
  });
  const api = vi.fn(() => ({ post }));
  return { client: { api } as unknown as Client, api, sent };
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `msg-${i}`);
}

describe('fetch_message_reaction_properties', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads 25 messages in two round trips of at most 20, chained and with immutable ids', async () => {
    const { client, api, sent } = batch_client(ok);

    const found = await fetch_message_reaction_properties(client, 'owner-1', ids(25), PREFER);

    expect(api).toHaveBeenCalledWith('/$batch');
    expect(sent.map((requests) => requests.length)).toEqual([20, 5]);
    expect(sent[0]![0]!.dependsOn).toBeUndefined();
    expect(sent[0]![1]!.dependsOn).toEqual(['0']);
    expect(sent[0]![0]!.headers).toEqual({ Prefer: PREFER });
    expect(found.size).toBe(25);
    expect(found.get('msg-24')).toEqual([LIKE]);
  });

  it('drops a message Graph cannot find and resends only the reads its failure skipped', async () => {
    const { client, sent } = batch_client((id, pass) => {
      if (pass === 0 && id === 'msg-1')
        return { status: 404, body: { error: { code: 'ErrorItemNotFound' } } };
      if (pass === 0 && id !== 'msg-0') return { status: 424 };
      return ok();
    });

    const found = await fetch_message_reaction_properties(client, 'owner-1', ids(4), PREFER);

    expect(sent.map((requests) => requests.length)).toEqual([4, 2]);
    expect([...found.keys()]).toEqual(['msg-0', 'msg-2', 'msg-3']);
  });

  it('backs off on a throttled read and resends only the unsettled ones', async () => {
    const { client, sent } = batch_client((id, pass) => {
      if (pass === 0 && id === 'msg-2') return { status: 429, headers: { 'Retry-After': '1' } };
      if (pass === 0 && id === 'msg-3') return { status: 424 };
      return ok();
    });

    const pending = fetch_message_reaction_properties(client, 'owner-1', ids(4), PREFER);
    await vi.runAllTimersAsync();
    const found = await pending;

    expect(sent.map((requests) => requests.length)).toEqual([4, 2]);
    expect(found.size).toBe(4);
  });

  it('throws on a refused permission instead of reporting messages without reactions', async () => {
    const { client } = batch_client(() => ({
      status: 403,
      body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } },
    }));

    await expect(
      fetch_message_reaction_properties(client, 'owner-1', ids(2), PREFER),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
