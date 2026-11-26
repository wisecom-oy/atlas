/**
 * Issue #888: the reaction `$batch` read runs its whole POST loop inside one attempt. An attempt
 * that timed out kept looping beside its retry: it sent more POSTs and wrote into the result its
 * caller shared with the next attempt. A real Graph client runs here over a transport that never
 * answers unless told to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create_graph_client } from '@wisecom/atlas-m365-graph';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  graph_json_response,
  held_graph_fetch,
  type HeldGraphFetch,
} from '@wisecom/atlas-types/testing/held-graph-fetch';
import { fetch_message_extended_properties } from '@/adapters/graph-message-extended-property-fetcher';

const TIMEOUT_MS = 60_000;
const PREFER = 'IdType="ImmutableId"';
const READ = { status: 200, body: { id: 'x', singleValueExtendedProperties: [] } };

let rig: HeldGraphFetch;
const client = create_graph_client({ getAccessToken: () => Promise.resolve('token') });

/** A `$batch` answer giving each sub-request, by its position, the answer in `answers`. */
function batch_answer(...answers: { status: number; body?: unknown }[]): Response {
  return graph_json_response({
    responses: answers.map((answer, index) => ({ id: String(index), ...answer })),
  });
}

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

describe('fetch_message_extended_properties with an abandoned attempt (issue #888)', () => {
  it('closes the open POST at the timeout and sends no further POST from that attempt', async () => {
    const read = fetch_message_extended_properties(client, 'owner', ['m-0', 'm-1'], PREFER);
    await vi.advanceTimersByTimeAsync(0);
    // The first POST settles m-0; m-1 was skipped behind it, so the attempt posts it again.
    rig.answer(0, batch_answer(READ, { status: 424 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.requests).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(rig.requests[1]!.closed_at).toBe(TIMEOUT_MS);
    expect(rig.requests).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(rig.requests).toHaveLength(3);
    rig.answer(2, batch_answer(READ));

    const found = await read;
    expect([...found.keys()]).toEqual(['m-0', 'm-1']);
    expect(rig.requests.every((request) => request.method === 'POST')).toBe(true);
  });

  it('records nothing from an answer that lands as its attempt expires', async () => {
    const read = fetch_message_extended_properties(client, 'owner', ['m-0'], PREFER);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);

    rig.answer(0, batch_answer(READ));
    vi.advanceTimersByTime(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(rig.requests).toHaveLength(2);
    rig.answer(1, batch_answer(READ));
    expect([...(await read).keys()]).toEqual(['m-0']);
  });

  it('closes the POST on Ctrl+C, so nothing changes the result once the caller has it', async () => {
    const run = new AbortController();
    const read = run_with_abort_signal(run.signal, () =>
      fetch_message_extended_properties(client, 'owner', ['m-0'], PREFER),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    run.abort(new Error('Run interrupted by Ctrl+C'));
    const found = await read;
    rig.answer(0, batch_answer(READ));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(rig.requests[0]!.closed_at).toBe(1_000);
    expect(rig.requests).toHaveLength(1);
    expect(found.size).toBe(0);
  });
});
