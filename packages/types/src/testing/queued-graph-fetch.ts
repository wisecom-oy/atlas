/**
 * A `fetch` stand-in that answers each request with the next queued response, for driving a real
 * Graph client (`Client.initWithMiddleware({ middleware: new HTTPMessageHandler() })`) through its
 * own response handling. Stub it in with `vi.stubGlobal('fetch', rig.fetch)`.
 */

export interface QueuedGraphFetch {
  /** The stub to install as the global `fetch`. */
  readonly fetch: typeof fetch;
  /** The URL of every request made, in order. */
  readonly urls: string[];
}

/** Builds a `fetch` that serves `responses` in order and fails any request past the last one. */
export function queued_graph_fetch(...responses: Response[]): QueuedGraphFetch {
  const urls: string[] = [];
  const queue = [...responses];
  const stub = async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    const next = queue.shift();
    if (next === undefined) throw new Error(`queued_graph_fetch: no response left for ${url}`);
    return next;
  };
  return { fetch: stub, urls };
}

/** A Graph JSON error response with the given status, error code and response headers. */
export function graph_error_response(
  status: number,
  code: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const body = JSON.stringify({ error: { code, message: `${code} message` } });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** A 429 Graph answers when it throttles, carrying the given `Retry-After` value. */
export function throttled_graph_response(retry_after: string): Response {
  return graph_error_response(429, 'TooManyRequests', { 'Retry-After': retry_after });
}

/** A 200 carrying `bytes` as an octet stream. */
export function binary_graph_response(bytes: Uint8Array): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}
