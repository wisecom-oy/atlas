import { Readable as NodeReadable } from 'node:stream';
import type { Client } from '@microsoft/microsoft-graph-client';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';

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
