import type { Readable } from 'node:stream';

import { compute_chunk_timeout_ms } from '@/adapters/graph-onedrive-chunked-download';

/**
 * Drains a readable stream into a buffer with a wall-clock timeout.
 * On timeout, destroys the stream so backing resources are released.
 */
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

/**
 * Settles when `promise` fulfills or rejects before `timeout_ms`, otherwise rejects with `message`.
 * @throws Error if promise does not settle before timeout_ms.
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
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout_ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Downloads a pre-authenticated OneDrive URL into a buffer. */
export async function download_from_url(
  download_url: string,
  size_bytes: number,
  item_id: string,
): Promise<Buffer> {
  const timeout_ms = compute_chunk_timeout_ms(size_bytes);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const response = await fetch(download_url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to download OneDrive file ${item_id}: HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}
