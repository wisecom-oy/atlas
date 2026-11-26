import type { GraphRequest } from '@microsoft/microsoft-graph-client';
import { get_graph_binary_response } from '@/graph-binary-download';

/**
 * Longest a binary download may go without its response headers or a body chunk arriving.
 *
 * Equal to the default per-attempt timeout: no request may go longer without a byte than an
 * ordinary Graph request may take in total. A slow link still delivers TCP segments far more
 * often, so a large body that keeps moving is never cut off (issue #33), while a server that has
 * stopped sending loses its attempt after 60 s instead of holding it for the whole attempt window,
 * or for undici's 300 s idle timeout (issue #883).
 */
export const GRAPH_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/** A binary Graph resource read in full, with the Content-Type it was served with. */
export interface GraphBinaryDownload {
  readonly bytes: Buffer;
  readonly content_type: string | undefined;
}

/**
 * Fires when nothing has arrived for `idle_ms`, or when the attempt's own signal fires. `touch`
 * restarts the idle clock. The signal is handed to fetch and to the body reader, so firing closes
 * the request rather than leaving it running beside the next attempt.
 */
class IdleWatchdog {
  private readonly _controller = new AbortController();
  private readonly forward_attempt_abort = (): void => {
    this._controller.abort(this._attempt_signal.reason);
  };
  private _timer: NodeJS.Timeout | undefined;
  private _stalled = false;

  constructor(
    private readonly _idle_ms: number,
    private readonly _attempt_signal: AbortSignal,
  ) {
    if (_attempt_signal.aborted) this.forward_attempt_abort();
    else _attempt_signal.addEventListener('abort', this.forward_attempt_abort, { once: true });
    this.touch();
  }

  /** The signal that fires on a stall or on the attempt's abort. */
  get signal(): AbortSignal {
    return this._controller.signal;
  }

  /** The stall error when the idle clock ran out, otherwise undefined. */
  get stall_error(): unknown {
    return this._stalled ? (this._controller.signal.reason as unknown) : undefined;
  }

  /** Restarts the idle clock, because headers or a body chunk just arrived. */
  touch(): void {
    clearTimeout(this._timer);
    if (this._controller.signal.aborted) return;
    this._timer = setTimeout(() => {
      this._stalled = true;
      this._controller.abort(idle_timeout_error(this._idle_ms));
    }, this._idle_ms);
  }

  /** Stops the idle clock and detaches from the attempt's signal. */
  release(): void {
    clearTimeout(this._timer);
    this._attempt_signal.removeEventListener('abort', this.forward_attempt_abort);
  }
}

/**
 * The error a stalled download fails with. It carries `ETIMEDOUT`, the code a timed-out attempt
 * carries, so `with_graph_retry` retries it as a timed-out transfer.
 */
function idle_timeout_error(idle_ms: number): Error {
  const message = `No data from Microsoft Graph for ${Math.round(idle_ms / 1000)} s`;
  return Object.assign(new Error(message), { code: 'ETIMEDOUT' });
}

/**
 * Downloads a binary Graph resource (`$value`) into memory inside one `with_graph_retry` attempt,
 * returning its bytes and Content-Type. Pass the attempt's signal.
 *
 * The body is read here, inside the attempt, so the attempt timeout, a retry on a body cut off
 * mid-stream, and the run's cancellation all cover it (issue #877). When neither the headers nor a
 * body chunk arrive for `idle_timeout_ms`, the request is closed and the call rejects with an
 * `ETIMEDOUT` error that the retry loop repeats (issue #883). A non-2xx is thrown as the GraphError
 * `get_graph_binary_response` builds, headers included.
 */
export async function get_graph_binary_with_idle_timeout(
  request: GraphRequest,
  attempt_signal: AbortSignal,
  idle_timeout_ms: number = GRAPH_DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<GraphBinaryDownload> {
  const watchdog = new IdleWatchdog(idle_timeout_ms, attempt_signal);
  try {
    const response = await get_graph_binary_response(request.option('signal', watchdog.signal));
    watchdog.touch();
    const bytes = await read_body_restarting_idle_clock(response.body, watchdog);
    return { bytes, content_type: response.headers.get('content-type') ?? undefined };
  } catch (err) {
    // A stall aborts fetch, and the Graph SDK rewraps the abort without its code.
    throw watchdog.stall_error ?? err;
  } finally {
    watchdog.release();
  }
}

/**
 * Reads a response body to its end, restarting the idle clock on every chunk. When the watchdog
 * fires, the reader is cancelled, which settles a pending read and closes the stream, and the
 * read rejects with the watchdog's reason rather than returning the bytes read so far.
 */
async function read_body_restarting_idle_clock(
  body: ReadableStream<Uint8Array> | null,
  watchdog: IdleWatchdog,
): Promise<Buffer> {
  if (body === null) return Buffer.alloc(0);
  const reader = body.getReader();
  const cancel_reader = (): void => {
    reader.cancel(watchdog.signal.reason).catch(() => undefined);
  };
  watchdog.signal.addEventListener('abort', cancel_reader, { once: true });
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await read_next_chunk(reader, watchdog.signal);
      if (done) return Buffer.concat(chunks);
      watchdog.touch();
      chunks.push(value);
    }
  } finally {
    watchdog.signal.removeEventListener('abort', cancel_reader);
  }
}

/** One read, rethrowing the watchdog's reason when it fired, whether the read failed or not. */
async function read_next_chunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  signal.throwIfAborted();
  try {
    const result = await reader.read();
    signal.throwIfAborted();
    return result;
  } catch (err) {
    signal.throwIfAborted();
    throw err;
  }
}
