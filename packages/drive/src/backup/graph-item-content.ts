import { get_graph_content_stream, with_graph_retry } from '@wisecom/atlas-m365-graph';
import type { DriveDeltaItem } from '@/drive-ports';
import { compute_chunk_timeout_ms } from '@/backup/cdn-chunk-request';
import { assert_transferred_size } from '@/backup/download-integrity';
import { stream_to_buffer, with_timeout } from '@/backup/stream-drain';

/**
 * The fields of a delta item the download path reads. Both providers' delta items satisfy it, so
 * the shared executor stays independent of which one it was handed.
 */
export type DriveDownloadItem = Pick<
  DriveDeltaItem,
  'drive_id' | 'item_id' | 'file_name' | 'size_bytes' | 'download_url'
>;

/** The request the download path builds: the Graph SDK's own `GraphRequest`. */
export type DriveGraphRequest = Parameters<typeof get_graph_content_stream>[0];

/**
 * The slice of the Graph SDK `Client` the download path calls. The request type comes from
 * m365-graph's `get_graph_content_stream`, so this package names the SDK's `GraphRequest` without
 * depending on the SDK itself, and the providers pass their `Client` unchanged.
 */
export interface DriveGraphClient {
  api(path: string): DriveGraphRequest;
}

interface GraphDriveItemDownload {
  '@microsoft.graph.downloadUrl'?: string;
}

/** Resolves the temporary pre-authenticated download URL for a file via Graph. */
export async function resolve_download_url(
  client: DriveGraphClient,
  item: DriveDownloadItem,
): Promise<string | undefined> {
  const response = await with_graph_retry(
    () =>
      client
        .api(`/drives/${item.drive_id}/items/${item.item_id}`)
        .select('@microsoft.graph.downloadUrl')
        .get() as Promise<GraphDriveItemDownload>,
  );
  return response['@microsoft.graph.downloadUrl'];
}

/**
 * Downloads via the Graph /content endpoint with stream drain.
 *
 * The request goes through `get_graph_content_stream`, so a throttled `/content` keeps its
 * Retry-After and `with_graph_retry` waits as long as Graph asked (issue #674). The request timeout
 * applies to each attempt, not to the retry loop, so a Retry-After longer than the timeout is waited
 * out instead of being cut off as a timed-out request. The drained byte
 * count is checked against the recorded size for the same reason the chunked path checks it: a
 * complete-looking body of the wrong length would otherwise be stored with a checksum computed
 * over those wrong bytes (issue #368).
 */
export async function download_via_graph_content(
  client: DriveGraphClient,
  item: DriveDownloadItem,
): Promise<Buffer> {
  const content_path = `/drives/${item.drive_id}/items/${item.item_id}/content`;
  const stream_timeout_ms = compute_chunk_timeout_ms(item.size_bytes);
  const stream = await with_graph_retry(() =>
    with_timeout(
      get_graph_content_stream(client.api(content_path)),
      stream_timeout_ms,
      `Graph content request timed out for file ${item.item_id}`,
    ),
  );
  const drain_timeout_ms = stream_timeout_ms * 2;
  // A web stream on Node's fetch; the drain reads it through a reader.
  const body = await stream_to_buffer(stream as unknown as NodeJS.ReadableStream, drain_timeout_ms);
  assert_transferred_size(item.item_id, body.length, item.size_bytes);
  return body;
}
