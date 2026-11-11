import type { Readable } from 'node:stream';

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
 * Drains a readable stream into a buffer with a wall-clock timeout.
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
          reject(new Error('Graph content stream timed out'));
        }, timeout_ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

/**
 * Settles with `promise` when it settles before `timeout_ms`, otherwise rejects with `message`.
 * The timer is cleared however the race ends.
 */
export async function with_timeout<T>(
  promise: Promise<T>,
  timeout_ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout_ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
