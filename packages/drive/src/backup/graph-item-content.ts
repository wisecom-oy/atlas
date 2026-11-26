import { get_graph_content_stream, with_graph_retry } from '@wisecom/atlas-m365-graph';
import type { DriveDeltaItem } from '@/drive-ports';
import { compute_chunk_timeout_ms } from '@/backup/cdn-chunk-request';
import { assert_transferred_size } from '@/backup/download-integrity';
import { stream_to_buffer, with_timeout } from '@/backup/stream-drain';
import { TransferTimeoutError } from '@/backup/transfer-timeout';

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
 * Headroom of `with_graph_retry`'s own per-attempt timeout over the `/content` request timeout, so
 * the request timeout here always fires first and the attempt ends as a `TransferTimeoutError`.
 */
const GRAPH_ATTEMPT_TIMEOUT_MARGIN_MS = 5_000;

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
 *
 * A request or a body that times out ends as a `TransferTimeoutError`, which `with_graph_retry`
 * does not repeat: the download host behind `/content` has stalled, and the file-level loop retries
 * it within its 3 attempts instead of spending Graph's 12-retry budget on it (issues #885, #890).
 * The timed-out request is aborted, so its socket is released before the next attempt.
 * `abort_signal` cancels the request with the run.
 */
export async function download_via_graph_content(
  client: DriveGraphClient,
  item: DriveDownloadItem,
  abort_signal?: AbortSignal,
): Promise<Buffer> {
  const stream_timeout_ms = compute_chunk_timeout_ms(item.size_bytes);
  const request: ContentRequest = {
    path: `/drives/${item.drive_id}/items/${item.item_id}/content`,
    timeout_ms: stream_timeout_ms,
    timeout_message: `Graph content request timed out for file ${item.item_id}`,
  };
  const stream = await with_graph_retry(
    (attempt_signal) => open_content_stream(client, request, [attempt_signal, abort_signal]),
    { timeout_ms: stream_timeout_ms + GRAPH_ATTEMPT_TIMEOUT_MARGIN_MS },
  );
  const drain_timeout_ms = stream_timeout_ms * 2;
  // A web stream on Node's fetch; the drain reads it through a reader.
  const body = await stream_to_buffer(stream as unknown as NodeJS.ReadableStream, drain_timeout_ms);
  assert_transferred_size(item.item_id, body.length, item.size_bytes);
  return body;
}

/** One `/content` request: where it goes and how long it may wait for a response. */
interface ContentRequest {
  readonly path: string;
  readonly timeout_ms: number;
  readonly timeout_message: string;
}

/**
 * Sends one `/content` request under its timeout, aborting it when the timeout fires or any of
 * `cancel_signals` does. The listeners are removed once the request settles, so the stream it
 * returns is not torn down by a later abort.
 */
async function open_content_stream(
  client: DriveGraphClient,
  request: ContentRequest,
  cancel_signals: readonly (AbortSignal | undefined)[],
): Promise<ReadableStream<Uint8Array>> {
  const controller = new AbortController();
  const detach = forward_aborts(cancel_signals, controller);
  try {
    return await with_timeout(
      get_graph_content_stream(client.api(request.path).option('signal', controller.signal)),
      request.timeout_ms,
      request.timeout_message,
      () => controller.abort(new TransferTimeoutError(request.timeout_message)),
    );
  } finally {
    detach();
  }
}

/** Aborts `target` when any of `sources` fires, and returns the function that detaches them. */
function forward_aborts(
  sources: readonly (AbortSignal | undefined)[],
  target: AbortController,
): () => void {
  const detachers = sources
    .filter((signal): signal is AbortSignal => signal !== undefined)
    .map((signal) => {
      const abort = (): void => target.abort(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      return (): void => signal.removeEventListener('abort', abort);
    });
  return (): void => {
    for (const detach of detachers) detach();
  };
}
