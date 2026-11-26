import type { Client } from '@microsoft/microsoft-graph-client';
import { get_graph_binary_with_idle_timeout, with_graph_retry } from '@wisecom/atlas-m365-graph';

/**
 * Per-attempt timeout for attachment `$value` transfers (up to ~150 MB): the default 60 s window
 * kills large bodies on slow links (issue #33). A body that stops arriving is cut off sooner, by
 * the download's 60 s idle timeout (issue #883).
 */
const LARGE_DOWNLOAD_TIMEOUT_MS = 1_800_000;

/**
 * Downloads raw attachment bytes via /attachments/{id}/$value. Raw transfer
 * avoids the +33% base64 overhead of contentBytes. Each attachment gets its
 * own retry window so a large binary cannot starve the page-listing budget.
 * The widened timeout follows corso's large-file calibration: attachments
 * run up to 150 MB and the default 60s window kills them on slow links. The
 * body is read inside each attempt, so a stalled body is retried after the
 * idle timeout rather than holding its attempt for the full window.
 */
export async function fetch_attachment_content(
  client: Client,
  owner_id: string,
  message_id: string,
  attachment_id: string,
  immutable_id_prefer: string,
): Promise<Buffer> {
  const url = `/users/${owner_id}/messages/${message_id}/attachments/${attachment_id}/$value`;
  const { bytes } = await with_graph_retry(
    (attempt_signal) =>
      get_graph_binary_with_idle_timeout(
        client.api(url).header('Prefer', immutable_id_prefer),
        attempt_signal,
      ),
    { timeout_ms: LARGE_DOWNLOAD_TIMEOUT_MS },
  );
  return bytes;
}
