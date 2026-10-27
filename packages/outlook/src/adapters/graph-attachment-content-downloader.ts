import type { Client } from '@microsoft/microsoft-graph-client';
import { ResponseType } from '@microsoft/microsoft-graph-client';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';

// 30 min per attempt for attachment $value transfers (up to ~150 MB); the
// default 60s per-request window kills large bodies on slow links (issue #33).
const LARGE_DOWNLOAD_TIMEOUT_MS = 1_800_000;

/**
 * Downloads raw attachment bytes via /attachments/{id}/$value. Raw transfer
 * avoids the +33% base64 overhead of contentBytes. Each attachment gets its
 * own retry window so a large binary cannot starve the page-listing budget.
 * The widened timeout follows corso's large-file calibration: attachments
 * run up to 150 MB and the default 60s window kills them on slow links.
 */
export async function download_attachment_content(
  client: Client,
  owner_id: string,
  message_id: string,
  attachment_id: string,
  immutable_id_prefer: string,
): Promise<Buffer> {
  const url = `/users/${owner_id}/messages/${message_id}/attachments/${attachment_id}/$value`;
  const data = await with_graph_retry(
    () =>
      client
        .api(url)
        .header('Prefer', immutable_id_prefer)
        .responseType(ResponseType.ARRAYBUFFER)
        .get() as Promise<ArrayBuffer>,
    { timeout_ms: LARGE_DOWNLOAD_TIMEOUT_MS },
  );
  return Buffer.from(data);
}
