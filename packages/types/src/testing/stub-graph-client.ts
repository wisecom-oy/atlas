/**
 * A Microsoft Graph client stand-in for adapter tests.
 *
 * Adapters drive the SDK's fluent API (`client.api(url).select(...).get()`), so a stub has to
 * answer that chain and record what each call asked for. Routing every call through one function
 * keeps the scenario visible in the test, where a nest of per-call mocks would hide it.
 */

export type GraphMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface GraphCall {
  readonly method: GraphMethod;
  readonly url: string;
  readonly body?: unknown;
  /** The `$select` passed through `.select()`, when the adapter used it. */
  readonly select?: string;
}

/** Answers one call: return the response body, or throw to fail it. */
export type GraphRoute = (call: GraphCall) => unknown;

export interface GraphRequestStub {
  select(fields: string | string[]): GraphRequestStub;
  header(name: string, value: string): GraphRequestStub;
  headers(values: Record<string, string>): GraphRequestStub;
  get(): Promise<unknown>;
  post(body?: unknown): Promise<unknown>;
  put(body?: unknown): Promise<unknown>;
  patch(body?: unknown): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface StubGraphClient {
  /** Pass where an adapter takes a Graph `Client`. */
  readonly client: { api(url: string): GraphRequestStub };
  /** Every call made, in order. */
  readonly calls: GraphCall[];
}

/** Builds a Graph client whose every call is answered by `route` and recorded. */
export function stub_graph_client(route: GraphRoute): StubGraphClient {
  const calls: GraphCall[] = [];

  const api = (url: string): GraphRequestStub => {
    let select: string | undefined;
    const send = async (method: GraphMethod, body?: unknown): Promise<unknown> => {
      const call: GraphCall = {
        method,
        url,
        ...(body !== undefined ? { body } : {}),
        ...(select !== undefined ? { select } : {}),
      };
      calls.push(call);
      return route(call);
    };
    const request: GraphRequestStub = {
      select: (fields) => {
        select = Array.isArray(fields) ? fields.join(',') : fields;
        return request;
      },
      header: () => request,
      headers: () => request,
      get: () => send('get'),
      post: (body) => send('post', body),
      put: (body) => send('put', body),
      patch: (body) => send('patch', body),
      delete: () => send('delete'),
    };
    return request;
  };

  return { client: { api }, calls };
}

/**
 * An error shaped like the SDK's `GraphError`: the HTTP status on `statusCode`, Graph's error code
 * on `code`, and Graph's human-readable text as the message. The code and the text differ, which
 * is exactly what a classifier reading only one of them gets wrong.
 */
export function graph_error(status: number, code: string, message = code): Error {
  return Object.assign(new Error(message), {
    name: 'GraphError',
    statusCode: status,
    code,
    body: JSON.stringify({ code, message }),
  });
}
