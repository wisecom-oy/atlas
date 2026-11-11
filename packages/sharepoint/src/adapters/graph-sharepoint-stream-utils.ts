import { Readable as NodeReadable } from 'node:stream';
import type { Client } from '@microsoft/microsoft-graph-client';
import { get_graph_content_stream, with_graph_retry } from '@wisecom/atlas-m365-graph';

/** Opens a file version's content as a stream, retrying transient Graph faults. */
export async function open_version_content_stream(
  client: Client,
  drive_id: string,
  item_id: string,
  version_id: string,
): Promise<NodeJS.ReadableStream> {
  const url = `/drives/${drive_id}/items/${item_id}/versions/${version_id}/content`;
  const stream = await with_graph_retry(() => get_graph_content_stream(client.api(url)));
  return stream as unknown as NodeJS.ReadableStream;
}

/** Presents a Graph content stream as an async iterable of buffers. */
export function as_buffer_iterable(stream: NodeJS.ReadableStream): AsyncIterable<Buffer> {
  return stream instanceof NodeReadable
    ? stream
    : NodeReadable.from(stream as AsyncIterable<Buffer>);
}
