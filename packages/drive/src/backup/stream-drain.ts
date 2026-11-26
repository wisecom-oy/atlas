import type { Readable } from 'node:stream';
import { TransferTimeoutError } from '@/backup/transfer-timeout';

/** A stream's chunks, plus a way to give the stream up while a read is still pending. */
interface ChunkSource {
  readonly chunks: AsyncIterable<Uint8Array | string>;
  release(): void;
}

/** Reads every chunk from a web stream reader until it reports done. */
async function* read_web_chunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

/**
 * Opens a Node or web stream for draining. Graph's `/content` body is a web `ReadableStream` on
 * Node's built-in fetch, which has no `destroy()`, so it is read through a reader whose `cancel()`
 * also settles a pending read. A Node stream is read directly and destroyed.
 */
function open_chunk_source(stream: NodeJS.ReadableStream): ChunkSource {
  const candidate = stream as unknown as { getReader?: unknown };
  if (typeof candidate.getReader === 'function') {
    const reader = (stream as unknown as ReadableStream<Uint8Array>).getReader();
    return {
      chunks: read_web_chunks(reader),
      release: () => {
        reader.cancel().catch(() => undefined);
      },
    };
  }
  const readable = stream as Readable;
  return { chunks: readable, release: () => readable.destroy() };
}

/**
 * Drains a readable stream into a buffer with a wall-clock timeout, rejecting with
 * `TransferTimeoutError` when it runs out.
 *
 * On timeout the stream is released (destroyed, or cancelled for a web stream) so its socket is
 * freed. The timer is cleared in `finally`, so a drain that ends, fails or times out leaves nothing
 * armed. The SharePoint copy this replaced cleared it only on a clean end: a stream that errored
 * kept the timer, the event loop and the buffered chunks alive for the whole drain budget, then
 * destroyed a stream that had already failed (issue #676).
 */
export async function stream_to_buffer(
  stream: NodeJS.ReadableStream,
  timeout_ms: number,
): Promise<Buffer> {
  const source = open_chunk_source(stream);
  const chunks: Uint8Array[] = [];
  const read_stream = async (): Promise<void> => {
    for await (const chunk of source.chunks) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      read_stream(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          source.release();
          reject(new TransferTimeoutError('Graph content stream timed out'));
        }, timeout_ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

/**
 * Settles with `promise` when it settles before `timeout_ms`, otherwise rejects with a
 * `TransferTimeoutError` carrying `message` and then calls `on_timeout`.
 *
 * Racing alone only stops waiting: `on_timeout` is where the caller aborts the request, so a timed
 * out request is closed rather than left open beside the next attempt (issue #890). The timer is
 * cleared however the race ends.
 */
export async function with_timeout<T>(
  promise: Promise<T>,
  timeout_ms: number,
  message: string,
  on_timeout: () => void = () => undefined,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Rejected first, so the race settles with the timeout, not the abort it causes.
          reject(new TransferTimeoutError(message));
          on_timeout();
        }, timeout_ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
