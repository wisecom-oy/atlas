/**
 * Issue #888: a Graph read whose attempt timed out kept running beside its retry, because only the
 * call sites that passed the attempt signal to the request could close it. Every backup read took
 * a zero-argument closure. A real Graph client runs here over a transport that never answers, so
 * the client's own middleware decides which signal each request carries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  graph_json_response,
  held_graph_fetch,
  type HeldGraphFetch,
} from '@wisecom/atlas-types/testing/held-graph-fetch';
import { create_graph_client } from '@/graph-client.factory';
import { with_graph_retry } from '@/graph-request-error-handler';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TIMEOUT_MS = 60_000;
const CANCEL = new Error('Run interrupted by Ctrl+C');
const STATIC_TOKEN: AuthenticationProvider = { getAccessToken: () => Promise.resolve('token') };

let rig: HeldGraphFetch;
const client = create_graph_client(STATIC_TOKEN);

/** Settles `promise` into its value or its error, so a rejection is never left unhandled. */
function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => value,
    (err: unknown) => err,
  );
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

describe('a timed-out attempt closes its request before the retry (issue #888)', () => {
  it('closes a read that passed no signal at its timeout, before the next attempt is sent', async () => {
    const outcome = settled(with_graph_retry(() => client.api('/users/u/mailFolders').get()));

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(rig.requests).toHaveLength(1);
    expect(rig.requests[0]!.closed_at).toBe(TIMEOUT_MS);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(rig.requests).toHaveLength(2);
    expect(rig.requests[1]!.sent_at).toBeGreaterThan(rig.requests[0]!.closed_at!);

    rig.answer(1, graph_json_response({ value: [] }));
    await expect(outcome).resolves.toEqual({ value: [] });
  });

  it('closes a write at its timeout too, so a create is never left open beside its retry', async () => {
    const outcome = settled(
      with_graph_retry(() => client.api('/users/u/events').post({}), { idempotent: false }),
    );

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(rig.requests[0]!.method).toBe('POST');
    expect(rig.requests[0]!.closed_at).toBe(TIMEOUT_MS);
    expect(await outcome).toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('keeps a signal the call site set itself', async () => {
    const own = new AbortController();
    const outcome = settled(
      with_graph_retry(() => client.api('/users/u').option('signal', own.signal).get()),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(rig.requests[0]!.signal).toBe(own.signal);
    rig.answer(0, graph_json_response({ id: 'u' }));
    await expect(outcome).resolves.toEqual({ id: 'u' });
  });

  it('sends a request made outside any attempt without a signal', async () => {
    void settled(client.api('/users/u').get());
    await vi.advanceTimersByTimeAsync(0);

    expect(rig.requests[0]!.signal).toBeUndefined();
  });
});

describe('a cancelled run closes its reads and lets its writes finish (issues #888, #875)', () => {
  /** Starts `call` under a run signal and cancels the run 1 s later. */
  async function cancelled_one_second_in(call: () => Promise<unknown>): Promise<unknown> {
    const run = new AbortController();
    const outcome = settled(run_with_abort_signal(run.signal, call));
    await vi.advanceTimersByTimeAsync(1_000);
    run.abort(CANCEL);
    await vi.advanceTimersByTimeAsync(0);
    return outcome;
  }

  it('closes a read on Ctrl+C at once', async () => {
    const outcome = await cancelled_one_second_in(() =>
      with_graph_retry(() => client.api('/users/u/messages/delta').get()),
    );

    expect(outcome).toBe(CANCEL);
    expect(rig.requests[0]!.closed_at).toBe(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a write already on the wire finish on Ctrl+C', async () => {
    const outcome = cancelled_one_second_in(() =>
      with_graph_retry(() => client.api('/users/u/mailFolders').post({}), {
        idempotent: false,
        complete_in_flight: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rig.requests[0]!.closed_at).toBeUndefined();

    rig.answer(0, graph_json_response({ id: 'folder' }));
    await expect(outcome).resolves.toEqual({ id: 'folder' });
  });

  it('tears down a write the caller stopped waiting for at its timeout, not later', async () => {
    const outcome = await cancelled_one_second_in(() =>
      with_graph_retry(() => client.api('/drives/d/items/i').patch({})),
    );
    expect(outcome).toBe(CANCEL);
    expect(rig.requests[0]!.closed_at).toBeUndefined();

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(rig.requests[0]!.closed_at).toBe(TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a run with no abandoned request leaves nothing behind (issue #875)', () => {
  it('clears the attempt timer and the run listener once the read is answered', async () => {
    const run = new AbortController();
    const add = vi.spyOn(run.signal, 'addEventListener');
    const remove = vi.spyOn(run.signal, 'removeEventListener');
    const outcome = run_with_abort_signal(run.signal, () =>
      with_graph_retry(() => client.api('/users/u').get()),
    );
    await vi.advanceTimersByTimeAsync(0);

    rig.answer(0, graph_json_response({ id: 'u' }));

    await expect(outcome).resolves.toEqual({ id: 'u' });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
  });
});
