import type { Context, Middleware } from '@microsoft/microsoft-graph-client';

/** What the middleware needs from the authentication provider: a way to drop a rejected token. */
export interface RejectedTokenSink {
  discard_rejected_token(rejected_token: string | undefined): void;
}

const BEARER_PREFIX = /^Bearer\s+/i;

/**
 * Discards the access token of every request Graph answers `401`, so the next attempt that
 * `with_graph_retry` makes carries a newly issued token rather than the one Graph just rejected
 * (issue #861). It does not repeat the request: retry policy stays in `with_graph_retry`.
 *
 * It sits below RedirectHandler, which re-executes the chain beneath it, so it reads the headers of
 * each hop actually sent. A redirect to another host drops the `Authorization` header, so a `401`
 * from that host names no token and is ignored.
 */
export class GraphTokenRejectionMiddleware implements Middleware {
  private _next?: Middleware;

  constructor(private readonly sink: RejectedTokenSink) {}

  /** Sends the request, then discards its token when Graph answered `401`. */
  async execute(context: Context): Promise<void> {
    await this._next?.execute(context);
    if (context.response?.status !== 401) return;
    const authorization = read_authorization_header(context);
    if (authorization === undefined) return;
    this.sink.discard_rejected_token(bearer_token(authorization));
  }

  setNext(next: Middleware): void {
    this._next = next;
  }
}

/** The token in a `Bearer` header, or undefined when the header holds something else. */
function bearer_token(authorization: string): string | undefined {
  if (!BEARER_PREFIX.test(authorization)) return undefined;
  const token = authorization.replace(BEARER_PREFIX, '').trim();
  return token === '' || token.includes(',') ? undefined : token;
}

/** The `Authorization` header the request carried, in any of the shapes the SDK stores headers. */
function read_authorization_header(context: Context): string | undefined {
  const request: unknown = context.request;
  if (typeof Request !== 'undefined' && request instanceof Request) {
    return request.headers.get('authorization') ?? undefined;
  }
  return read_header_value(context.options?.headers, 'authorization');
}

function read_header_value(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const entries: unknown[] = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const [key, value] = entry as unknown[];
    if (typeof key === 'string' && key.toLowerCase() === name && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}
