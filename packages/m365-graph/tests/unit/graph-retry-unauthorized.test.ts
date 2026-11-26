import type { AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  graph_error_response,
  queued_graph_fetch,
} from '@wisecom/atlas-types/testing/queued-graph-fetch';
import { create_graph_client } from '@/graph-client.factory';
import { with_graph_retry } from '@/graph-request-error-handler';
import { TypedTokenAuthProvider } from '@/graph-token-auth-provider';

/**
 * Issue #861: a Graph `401` on a token Entra ID had just issued ended the call on the first attempt,
 * and nothing discarded the token. A `401` is now repeated once with a newly issued token; one that
 * survives the new token is final at once rather than after the 24-minute budget.
 */

const INVALID_TOKEN = { statusCode: 401, code: 'InvalidAuthenticationToken', message: 'expired' };

type Attempt = () => Promise<unknown>;

/** An attempt that settles each call with the next outcome: a promise, or an error to reject with. */
function answers(...outcomes: unknown[]): Mock<Attempt> {
  const fn = vi.fn<Attempt>();
  for (const outcome of outcomes) {
    if (outcome instanceof Promise) fn.mockReturnValueOnce(outcome);
    else fn.mockRejectedValueOnce(outcome);
  }
  return fn;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('with_graph_retry on a Graph 401', () => {
  it('repeats a single 401 once and returns the answer', async () => {
    const fn = answers(INVALID_TOKEN, Promise.resolve('user'));

    const result = with_graph_retry(fn);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toBe('user');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('ends a 401 that survives the new token within seconds, with the 401', async () => {
    const fn = vi.fn<Attempt>().mockRejectedValue(INVALID_TOKEN);

    const failure = with_graph_retry(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await failure).toBe(INVALID_TOKEN);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('repeats a 401 only once per call, even after another retryable failure', async () => {
    const fn = answers(INVALID_TOKEN, { statusCode: 503 }, INVALID_TOKEN, Promise.resolve('user'));

    const failure = with_graph_retry(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await failure).toBe(INVALID_TOKEN);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not report a 401 on the last attempt as an outage', async () => {
    const fn = vi.fn<Attempt>();
    for (let i = 0; i < 12; i++) fn.mockRejectedValueOnce({ statusCode: 503 });
    fn.mockRejectedValueOnce(INVALID_TOKEN);

    const failure = with_graph_retry(fn).catch((e: unknown) => e);
    for (let i = 0; i < 13; i++) await vi.advanceTimersByTimeAsync(300_000);

    expect(await failure).toBe(INVALID_TOKEN);
    expect(fn).toHaveBeenCalledTimes(13);
  });

  it('still ends a 403 on the first attempt', async () => {
    const forbidden = { statusCode: 403, code: 'Authorization_RequestDenied' };
    const fn = vi.fn<Attempt>().mockRejectedValue(forbidden);

    expect(await with_graph_retry(fn).catch((e: unknown) => e)).toBe(forbidden);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('with_graph_retry on a Graph 401 for a write that is not idempotent', () => {
  it('repeats the write when Graph rejected the token, which it checks before processing', async () => {
    const fn = answers(INVALID_TOKEN, Promise.resolve('created'));

    const result = with_graph_retry(fn, { idempotent: false });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toBe('created');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('sends the write once when the 401 does not prove it was never processed', async () => {
    const unauthorized = { statusCode: 401, code: 'Unauthorized' };
    const fn = answers(unauthorized, Promise.resolve('created'));

    const failure = await with_graph_retry(fn, { idempotent: false }).catch((e: unknown) => e);

    expect(failure).toBe(unauthorized);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('a Graph 401 through the real client', () => {
  /** Credentials that each issue their own numbered token. */
  function numbered_credentials(): () => AuthenticationProvider {
    let built = 0;
    return () => {
      const token = `token-${++built}`;
      return { getAccessToken: () => Promise.resolve(token) };
    };
  }

  /** Installs `rig` as the global fetch, recording the Authorization header of every request. */
  function stub_fetch(rig: ReturnType<typeof queued_graph_fetch>): string[] {
    const authorizations: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
      return rig.fetch(input, init);
    });
    return authorizations;
  }

  it('sends the repeat with a newly issued token', async () => {
    const client = create_graph_client(new TypedTokenAuthProvider(numbered_credentials()));
    const authorizations = stub_fetch(
      queued_graph_fetch(
        graph_error_response(401, 'InvalidAuthenticationToken'),
        new Response(JSON.stringify({ id: 'user-id' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const result = with_graph_retry(() => client.api('/users/user-id').get() as Promise<unknown>);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toEqual({ id: 'user-id' });
    expect(authorizations).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('reports a 401 that the new token does not clear', async () => {
    const client = create_graph_client(new TypedTokenAuthProvider(numbered_credentials()));
    const authorizations = stub_fetch(
      queued_graph_fetch(
        graph_error_response(401, 'InvalidAuthenticationToken'),
        graph_error_response(401, 'InvalidAuthenticationToken'),
      ),
    );

    const failure = with_graph_retry(
      () => client.api('/users/user-id').get() as Promise<unknown>,
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await failure).toMatchObject({ statusCode: 401, code: 'InvalidAuthenticationToken' });
    expect(authorizations).toEqual(['Bearer token-1', 'Bearer token-2']);
  });
});
