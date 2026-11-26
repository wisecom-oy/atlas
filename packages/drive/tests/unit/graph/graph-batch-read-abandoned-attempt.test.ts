/**
 * Issue #888 for the drive `$batch` read: a `$batch` of reads is a POST, so it needs the attempt
 * signal passed explicitly to close on Ctrl+C, and an abandoned attempt must stop posting. A real
 * Graph client runs here over a transport that never answers unless told to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create_graph_client } from '@wisecom/atlas-m365-graph';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  graph_json_response,
  held_graph_fetch,
  type HeldGraphFetch,
} from '@wisecom/atlas-types/testing/held-graph-fetch';
import { batch_read_each, type BatchReadSpec } from '@/graph/graph-batch-read';

const TIMEOUT_MS = 60_000;
const SPEC: BatchReadSpec<unknown> = { label: 'Permission capture', read_body: (body) => body };
const REQUESTS = [{ key: 'item-1', url: '/drives/d/items/item-1/permissions' }];

let rig: HeldGraphFetch;
const client = create_graph_client({ getAccessToken: () => Promise.resolve('token') });

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

describe('batch_read_each with an abandoned attempt (issue #888)', () => {
  it('closes the timed-out POST before the retry posts again', async () => {
    const read = batch_read_each(client, REQUESTS, SPEC);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1_000);

    expect(rig.requests).toHaveLength(2);
    expect(rig.requests[0]!.closed_at).toBe(TIMEOUT_MS);
    rig.answer(1, graph_json_response({ responses: [{ id: '0', status: 200, body: {} }] }));
    expect([...(await read).keys()]).toEqual(['item-1']);
  });

  it('closes the POST at once on Ctrl+C', async () => {
    const run = new AbortController();
    const cancel = new Error('Run interrupted by Ctrl+C');
    const read = run_with_abort_signal(run.signal, () => batch_read_each(client, REQUESTS, SPEC));
    await vi.advanceTimersByTimeAsync(1_000);

    run.abort(cancel);

    await expect(read).rejects.toBe(cancel);
    expect(rig.requests[0]!.closed_at).toBe(1_000);
  });
});
