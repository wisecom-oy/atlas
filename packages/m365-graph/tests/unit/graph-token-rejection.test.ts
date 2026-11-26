import type {
  AuthenticationProvider,
  Context,
  Middleware,
} from '@microsoft/microsoft-graph-client';
import { describe, expect, it, vi } from 'vitest';
import { TypedTokenAuthProvider } from '@/graph-token-auth-provider';
import { GraphTokenRejectionMiddleware } from '@/graph-token-rejection-middleware';

/**
 * Issue #861: MSAL renews a cached token only near its expiry, so a token Graph rejected kept being
 * sent. A Graph `401` now discards the token that request carried, and the provider hands out a
 * newly issued one.
 */

/** Credentials that each issue their own numbered token, counting how many were built. */
function numbered_credentials(): { create: () => AuthenticationProvider; built: () => number } {
  let built = 0;
  return {
    create: () => {
      built++;
      const token = `token-${built}`;
      return { getAccessToken: () => Promise.resolve(token) };
    },
    built: () => built,
  };
}

/** A transport that answers with `status` and records nothing else. */
function answering(status: number): Middleware {
  return {
    execute: (context: Context) => {
      context.response = new Response(null, { status });
      return Promise.resolve();
    },
  } as Middleware;
}

function middleware_over(status: number, sink = { discard_rejected_token: vi.fn() }) {
  const middleware = new GraphTokenRejectionMiddleware(sink);
  middleware.setNext(answering(status));
  return { middleware, sink };
}

function graph_context(headers: Record<string, string> | Headers): Context {
  return { request: 'https://graph.microsoft.com/v1.0/users', options: { headers } } as Context;
}

describe('TypedTokenAuthProvider, discarding a rejected token', () => {
  it('hands out a newly issued token after the current one is rejected', async () => {
    const credentials = numbered_credentials();
    const provider = new TypedTokenAuthProvider(credentials.create);

    const rejected = await provider.getAccessToken();
    provider.discard_rejected_token(rejected);

    await expect(provider.getAccessToken()).resolves.toBe('token-2');
    expect(credentials.built()).toBe(2);
  });

  it('replaces the credential once for requests that failed together with the same token', async () => {
    const credentials = numbered_credentials();
    const provider = new TypedTokenAuthProvider(credentials.create);
    const rejected = await provider.getAccessToken();

    provider.discard_rejected_token(rejected);
    provider.discard_rejected_token(rejected);
    await provider.getAccessToken();
    provider.discard_rejected_token(rejected);

    expect(credentials.built()).toBe(2);
    await expect(provider.getAccessToken()).resolves.toBe('token-2');
  });

  it('replaces the credential when the rejected token could not be read', async () => {
    const credentials = numbered_credentials();
    const provider = new TypedTokenAuthProvider(credentials.create);
    await provider.getAccessToken();

    provider.discard_rejected_token(undefined);

    await expect(provider.getAccessToken()).resolves.toBe('token-2');
  });
});

describe('GraphTokenRejectionMiddleware', () => {
  it('discards the bearer token of a request Graph answered 401', async () => {
    const { middleware, sink } = middleware_over(401);

    await middleware.execute(graph_context({ Authorization: 'Bearer token-1' }));

    expect(sink.discard_rejected_token).toHaveBeenCalledExactlyOnceWith('token-1');
  });

  it('reads the header from a fetch Headers object too', async () => {
    const { middleware, sink } = middleware_over(401);

    await middleware.execute(graph_context(new Headers({ Authorization: 'Bearer token-1' })));

    expect(sink.discard_rejected_token).toHaveBeenCalledExactlyOnceWith('token-1');
  });

  it.each([200, 403, 404, 503])('keeps the token on a %i', async (status) => {
    const { middleware, sink } = middleware_over(status);

    await middleware.execute(graph_context({ Authorization: 'Bearer token-1' }));

    expect(sink.discard_rejected_token).not.toHaveBeenCalled();
  });

  it('ignores a 401 from a host the request carried no token to', async () => {
    const { middleware, sink } = middleware_over(401);

    await middleware.execute(graph_context({}));

    expect(sink.discard_rejected_token).not.toHaveBeenCalled();
  });
});
