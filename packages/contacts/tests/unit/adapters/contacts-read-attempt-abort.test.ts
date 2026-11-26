/**
 * Issue #888, Contacts: a backup read took a zero-argument closure, so a timed-out attempt left its
 * request open beside the retry. A real Graph client runs here over a transport that never answers,
 * so the client's own middleware decides whether the abort reaches the request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create_graph_client } from '@wisecom/atlas-m365-graph';
import {
  graph_json_response,
  held_graph_fetch,
  type HeldGraphFetch,
} from '@wisecom/atlas-types/testing/held-graph-fetch';
import { get_json } from '@/adapters/graph-contacts-requests';

const TIMEOUT_MS = 60_000;

let rig: HeldGraphFetch;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  rig = held_graph_fetch();
  vi.stubGlobal('fetch', rig.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('A contacts read (`get_json`) on a Graph that never answers (issue #888)', () => {
  it('closes the timed-out request before the next attempt is sent', async () => {
    const client = create_graph_client({ getAccessToken: () => Promise.resolve('token') });
    const read = get_json(client, '/users/u/contactFolders', 'Contacts.Read');

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1_000);

    expect(rig.requests).toHaveLength(2);
    expect(rig.requests[0]!.closed_at).toBe(TIMEOUT_MS);
    expect(rig.requests[1]!.sent_at).toBeGreaterThan(TIMEOUT_MS);
    rig.answer(1, graph_json_response({ value: [] }));
    await expect(read).resolves.toMatchObject({ value: [] });
  });
});
