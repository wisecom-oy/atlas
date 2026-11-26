import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GraphUserIdentityResolver } from '@/graph-user-identity-resolver.adapter';
import { NOT_FOUND_REREAD_DELAYS_MS } from '@/graph-not-found-confirmation';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';

/**
 * The owner lookup is the first read of a run, so a `404` on it follows the first-read
 * confirmation rule (#963): Graph answers `404` for a user that exists while a directory replica
 * lags, and a single answer used to end a first backup with exit `7`.
 */
const OBJECT_ID = '00000000-0000-0000-0000-000000000000';
const USER = { id: OBJECT_ID, displayName: 'John Doe', mail: 'john.doe@example.com' };

function graph_error(status: number, code?: string): Record<string, unknown> {
  return { statusCode: status, code, message: `HTTP ${status}` };
}

/** Graph client stub that answers `/users/{upn}` with `by_upn` and the mail filter with `by_mail`. */
function client_with(
  by_upn: () => Promise<unknown>,
  by_mail: () => Promise<unknown>,
  signals: AbortSignal[] = [],
): Client {
  const by_mail_request = {
    option: () => by_mail_request,
    filter: () => ({ select: () => ({ get: by_mail }) }),
  };
  const by_upn_request = {
    option: (_name: string, signal: AbortSignal) => (signals.push(signal), by_upn_request),
    select: () => ({ get: by_upn }),
  };
  return {
    api: (path: string) => (path === '/users' ? by_mail_request : by_upn_request),
  } as unknown as Client;
}

/** Runs a lookup to completion under fake timers and returns its result or rejection. */
async function settle(client: Client): Promise<unknown> {
  vi.useFakeTimers();
  const pending = new GraphUserIdentityResolver(client)
    .resolve_user('t', 'john.doe@example.com')
    .catch((e: unknown) => e);
  await vi.runAllTimersAsync();
  return pending;
}

describe('GraphUserIdentityResolver.resolve_user, 404 confirmation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('continues when a 404 clears on a repeated read', async () => {
    const by_upn = vi
      .fn()
      .mockRejectedValueOnce(graph_error(404, 'Request_ResourceNotFound'))
      .mockResolvedValueOnce(USER);
    const by_mail = vi.fn().mockResolvedValue({ value: [] });

    const identity = await settle(client_with(by_upn, by_mail));

    expect(identity).toMatchObject({ object_id: OBJECT_ID });
    expect(by_upn).toHaveBeenCalledTimes(2);
  });

  it('believes a 404 only after every read of both forms answered it', async () => {
    const not_found = graph_error(404, 'Request_ResourceNotFound');
    const by_upn = vi.fn(() => Promise.reject(not_found));
    const by_mail = vi.fn().mockResolvedValue({ value: [] });

    const err = await settle(client_with(by_upn, by_mail));

    const reads = NOT_FOUND_REREAD_DELAYS_MS.length + 1;
    expect(err).toBe(not_found);
    expect(by_upn).toHaveBeenCalledTimes(reads);
    expect(by_mail).toHaveBeenCalledTimes(reads);
  });

  it.each([400, 403])('passes a %i on from its first read', async (status) => {
    const by_upn = vi.fn(() => Promise.reject(graph_error(status)));
    const by_mail = vi.fn();

    const err = await settle(client_with(by_upn, by_mail));

    expect(err).toMatchObject({ statusCode: status });
    expect(by_upn).toHaveBeenCalledTimes(1);
    expect(by_mail).not.toHaveBeenCalled();
  });

  it('closes the request in flight when the run is cancelled', async () => {
    const signals: AbortSignal[] = [];
    const controller = new AbortController();
    const stop = new Error('Run interrupted by Ctrl+C');
    const client = client_with(() => new Promise<never>(() => undefined), vi.fn(), signals);

    const pending = run_with_abort_signal(controller.signal, () =>
      new GraphUserIdentityResolver(client).resolve_user('t', 'john.doe@example.com'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(stop);

    await expect(pending).rejects.toBe(stop);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});
