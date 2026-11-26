/**
 * A `fetch` stand-in for a Microsoft Graph that accepts every request and never answers, the way a
 * hung backend does. Each request stays open until the signal it was sent with fires, which is the
 * only way Atlas can close it. Stub it in with `vi.stubGlobal('fetch', rig.fetch)` under a real
 * Graph client (`create_graph_client`), so the client's own middleware decides which signal a
 * request carries.
 */

export interface HeldGraphRequest {
  readonly url: string;
  readonly method: string;
  /** The signal the request was sent with, or undefined when it carried none. */
  readonly signal: AbortSignal | undefined;
  /** `Date.now()` when the request was sent. */
  readonly sent_at: number;
  /** `Date.now()` when its signal closed it, or undefined while it is still open. */
  closed_at: number | undefined;
}

export interface HeldGraphFetch {
  /** The stub to install as the global `fetch`. */
  readonly fetch: typeof fetch;
  /** Every request sent, in order. */
  readonly requests: HeldGraphRequest[];
  /** Answers the open request at `index` with `response`. */
  answer(index: number, response: Response): void;
}

/** Builds a `fetch` that holds every request open until its signal fires or it is answered. */
export function held_graph_fetch(): HeldGraphFetch {
  const requests: HeldGraphRequest[] = [];
  const answers: ((response: Response) => void)[] = [];

  const stub = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = record_request(input, init);
    requests.push(request);
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    answers.push(resolve);
    const close = (): void => {
      request.closed_at = Date.now();
      reject(request.signal?.reason);
    };
    if (request.signal?.aborted === true) close();
    else request.signal?.addEventListener('abort', close, { once: true });
    return promise;
  };

  return {
    fetch: stub,
    requests,
    answer: (index, response) => answers[index]?.(response),
  };
}

function record_request(input: string | URL | Request, init?: RequestInit): HeldGraphRequest {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
  return { url, method, signal, sent_at: Date.now(), closed_at: undefined };
}

/** A 200 Graph answer carrying `body` as JSON. */
export function graph_json_response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
