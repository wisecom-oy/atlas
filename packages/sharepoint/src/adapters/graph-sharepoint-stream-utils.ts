import type { Readable } from 'node:stream';

/** Drains a readable stream into a Buffer with a timeout guard. */
export async function stream_to_buffer(
  stream: NodeJS.ReadableStream,
  timeout_ms: number,
): Promise<Buffer> {
  const readable = stream as Readable;
  const chunks: Buffer[] = [];
  const read_stream = async (): Promise<void> => {
    for await (const chunk of readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
    if (timer) clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}
