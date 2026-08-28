import { Readable as NodeReadable, type Readable } from 'node:stream';
import type { Client } from '@microsoft/microsoft-graph-client';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';

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

/** Opens a file version's content as a stream, retrying transient Graph faults. */
export async function open_version_content_stream(
  client: Client,
  drive_id: string,
  item_id: string,
  version_id: string,
): Promise<NodeJS.ReadableStream> {
  return await with_graph_retry(
    () =>
      client
        .api(`/drives/${drive_id}/items/${item_id}/versions/${version_id}/content`)
        .getStream() as Promise<NodeJS.ReadableStream>,
  );
}

/** Presents a Graph content stream as an async iterable of buffers. */
export function as_buffer_iterable(stream: NodeJS.ReadableStream): AsyncIterable<Buffer> {
  return stream instanceof NodeReadable
    ? stream
    : NodeReadable.from(stream as AsyncIterable<Buffer>);
}
