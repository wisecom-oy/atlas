import type { Readable } from 'node:stream';

/**
 * Drains a readable stream into a buffer with a wall-clock timeout.
 *
 * On timeout the stream is destroyed so its socket is released. The timer is cleared in `finally`,
 * so a drain that ends, fails or times out leaves nothing armed. The SharePoint copy this replaced
 * cleared it only on a clean end: a stream that errored kept the timer, the event loop and the
 * buffered chunks alive for the whole drain budget, then destroyed a stream that had already
 * failed (issue #676).
 */
export async function stream_to_buffer(
  stream: NodeJS.ReadableStream,
  timeout_ms: number,
): Promise<Buffer> {
  const readable = stream as Readable;
  const chunks: Uint8Array[] = [];
  const read_stream = async (): Promise<void> => {
    for await (const chunk of readable as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      read_stream(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          readable.destroy();
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
