/**
 * Issue #889: when the token endpoint was slow, the attempt timed out while the Graph SDK still
 * waited for a token, and the next attempt started a second token request beside the first. When
 * a token arrived, the abandoned attempt sent its Graph request anyway. A real Graph client runs
 * here over a transport that never answers unless told to, with a credential whose token requests
 * the test settles by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  record_graph_outage,
  run_stopping_on_graph_outage,
} from '@wisecom/atlas-core/services/shared/graph-outage-latch';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import {
  graph_json_response,
  held_graph_fetch,
  type HeldGraphFetch,
} from '@wisecom/atlas-types/testing/held-graph-fetch';
import { create_graph_client } from '@/graph-client.factory';
import { with_graph_retry } from '@/graph-request-error-handler';
import { TypedTokenAuthProvider } from '@/graph-token-auth-provider';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TIMEOUT_MS = 60_000;

/** A credential whose n-th token request settles only when the test resolves it. */
function manual_credential() {
  const pending: ((token: string) => void)[] = [];
  const credential: AuthenticationProvider = {
    getAccessToken: vi.fn(() => {
      const { promise, resolve } = Promise.withResolvers<string>();
      pending.push(resolve);
      return promise;
    }),
  };
  return { credential, issue: (index: number) => pending[index]?.('token') };
}

let rig: HeldGraphFetch;

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

describe('a Graph request waiting for its token (issue #889)', () => {
  it('is never sent once its attempt timed out, even when that token arrives', async () => {
    const entra = manual_credential();
    const client = create_graph_client(new TypedTokenAuthProvider(() => entra.credential));
    const outcome = settled(with_graph_retry(() => client.api('/users/u').get()));

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    entra.issue(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    entra.issue(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.requests).toHaveLength(1);
    rig.answer(0, graph_json_response({ id: 'u' }));
    await expect(outcome).resolves.toEqual({ id: 'u' });
  });

  it('shares one token request between requests that need a token together', async () => {
    const entra = manual_credential();
    const client = create_graph_client(new TypedTokenAuthProvider(() => entra.credential));
    const reads = ['/users/a', '/users/b', '/users/c'].map((url) =>
      settled(with_graph_retry(() => client.api(url).get())),
    );
    await vi.advanceTimersByTimeAsync(0);

    entra.issue(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(entra.credential.getAccessToken).toHaveBeenCalledTimes(1);
    expect(rig.requests).toHaveLength(3);
    rig.requests.forEach((_, index) => rig.answer(index, graph_json_response({})));
    await Promise.all(reads);
  });

  it('keeps the shared token request for the requests still waiting when one times out', async () => {
    const entra = manual_credential();
    const client = create_graph_client(new TypedTokenAuthProvider(() => entra.credential));
    const short = settled(
      with_graph_retry(() => client.api('/users/a').get(), { timeout_ms: 5_000 }),
    );
    const long = settled(with_graph_retry(() => client.api('/users/b').get()));

    await vi.advanceTimersByTimeAsync(5_000);
    entra.issue(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(entra.credential.getAccessToken).toHaveBeenCalledTimes(1);
    expect(rig.requests.map((request) => request.url)).toEqual([
      'https://graph.microsoft.com/v1.0/users/b',
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    entra.issue(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.requests).toHaveLength(2);
    rig.requests.forEach((_, index) => rig.answer(index, graph_json_response({})));
    await Promise.all([short, long]);
  });

  it('retries a create that timed out waiting for its token, since it was never sent', async () => {
    const entra = manual_credential();
    const client = create_graph_client(new TypedTokenAuthProvider(() => entra.credential));
    const outcome = settled(
      with_graph_retry(() => client.api('/users/u/events').post({}), {
        idempotent: false,
        complete_in_flight: true,
      }),
    );

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1_000);
    entra.issue(0);
    entra.issue(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(rig.requests).toHaveLength(1);
    rig.answer(0, graph_json_response({ id: 'event' }));
    await expect(outcome).resolves.toEqual({ id: 'event' });
  });

  it('does not send a write still waiting for its token when the run is cancelled', async () => {
    const entra = manual_credential();
    const client = create_graph_client(new TypedTokenAuthProvider(() => entra.credential));
    const run = new AbortController();
    const cancel = new Error('Run interrupted by Ctrl+C');
    const outcome = settled(
      run_with_abort_signal(run.signal, () =>
        with_graph_retry(() => client.api('/users/u/mailFolders').post({}), {
          idempotent: false,
          complete_in_flight: true,
        }),
      ),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    run.abort(cancel);
    entra.issue(0);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(await outcome).toBe(cancel);
    expect(rig.requests).toHaveLength(0);
  });

  it('ends a read still waiting for its token with the outage another call recorded', async () => {
    const entra = manual_credential();
    const client = create_graph_client(new TypedTokenAuthProvider(() => entra.credential));
    const outage = new GraphUnavailableError('Microsoft Graph unavailable', {
      retries: 12,
      elapsed_ms: 1,
    });
    let waiting: Promise<unknown> = Promise.resolve();
    const run = settled(
      run_stopping_on_graph_outage(undefined, async () => {
        waiting = settled(with_graph_retry(() => client.api('/users/u').get()));
        await vi.advanceTimersByTimeAsync(1_000);
        record_graph_outage(outage);
        return waiting;
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    entra.issue(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(rig.requests).toHaveLength(0);
    expect(await waiting).toBe(outage);
    expect(await run).toMatchObject({ name: outage.name, message: outage.message });
  });
});
