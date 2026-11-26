/**
 * A response body the test feeds by hand, for driving a download through a body that trickles,
 * stalls, or is cut off mid-stream. Wrap it in a `Response` and serve it with `queued_graph_fetch`.
 */
export interface ControlledResponseBody {
  /** The stream to pass to `new Response(...)`. */
  readonly stream: ReadableStream<Uint8Array>;
  /** Delivers one chunk to the reader. Does nothing once the reader has cancelled the body. */
  push(bytes: Uint8Array): void;
  /** Ends the body cleanly. */
  close(): void;
  /** Fails the body, as a socket that closed mid-transfer does. */
  fail(err: unknown): void;
  /** Whether the reader cancelled the body, which closes the connection on a real fetch. */
  readonly cancelled: boolean;
}

/** Builds a body that delivers only what the test pushes, and remembers whether it was cancelled. */
export function controlled_response_body(): ControlledResponseBody {
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller): void => {
      source = controller;
    },
    cancel: (): void => {
      cancelled = true;
    },
  });
  return {
    stream,
    push: (bytes): void => {
      if (!cancelled) source?.enqueue(bytes);
    },
    close: (): void => source?.close(),
    fail: (err): void => source?.error(err),
    get cancelled(): boolean {
      return cancelled;
    },
  };
}

/** A 200 whose body is `body`, with the given Content-Type. */
export function streamed_graph_response(
  body: ControlledResponseBody,
  content_type = 'application/octet-stream',
): Response {
  return new Response(body.stream, { status: 200, headers: { 'Content-Type': content_type } });
}

/**
 * The error undici rejects a body read with when the socket closes before the body ended: a
 * `TypeError: terminated` whose `cause` carries `UND_ERR_SOCKET`.
 */
export function terminated_body_error(): TypeError {
  return new TypeError('terminated', {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
  });
}

/** A `fetch` that never answers, and the signal of every request it received. */
export interface UnansweredFetch {
  readonly fetch: typeof fetch;
  readonly signals: AbortSignal[];
}

/**
 * A `fetch` whose requests never answer until their signal fires, then reject with its reason, as
 * a server that accepted the connection and sent no headers. Records each request's signal.
 */
export function unanswered_fetch(): UnansweredFetch {
  const signals: AbortSignal[] = [];
  const stub = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    if (signal) signals.push(signal);
    return new Promise<Response>((_, reject) => {
      signal?.addEventListener('abort', () => reject(as_error(signal.reason)), { once: true });
    });
  };
  return { fetch: stub, signals };
}

/** The abort reason as an Error, as fetch rejects with it. */
function as_error(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('aborted', { cause: reason });
}
