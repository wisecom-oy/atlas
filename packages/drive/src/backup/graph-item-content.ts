import { with_graph_retry } from '@wisecom/atlas-m365-graph';
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

/** The fluent request calls the download path makes on a Graph SDK request. */
export interface DriveGraphRequest {
  select(properties: string): DriveGraphRequest;
  get(): Promise<unknown>;
  getStream(): Promise<unknown>;
}

/**
 * The slice of the Graph SDK `Client` the download path calls. The SDK's `Client` satisfies it
 * structurally, so the providers pass theirs unchanged and this package needs no SDK dependency.
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
 * The drained byte count is checked against the recorded size for the same reason the chunked
 * path checks it: a complete-looking body of the wrong length would otherwise be stored with a
 * checksum computed over those wrong bytes (issue #368).
 */
export async function download_via_graph_content(
  client: DriveGraphClient,
  item: DriveDownloadItem,
): Promise<Buffer> {
  const stream_timeout_ms = compute_chunk_timeout_ms(item.size_bytes);
  const stream = await with_timeout(
    with_graph_retry(
      () =>
        client
          .api(`/drives/${item.drive_id}/items/${item.item_id}/content`)
          .getStream() as Promise<NodeJS.ReadableStream>,
    ),
    stream_timeout_ms,
    `Graph content request timed out for file ${item.item_id}`,
  );
  const drain_timeout_ms = stream_timeout_ms * 2;
  const body = await stream_to_buffer(stream, drain_timeout_ms);
  assert_transferred_size(item.item_id, body.length, item.size_bytes);
  return body;
}
