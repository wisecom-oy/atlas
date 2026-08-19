import type { Client } from '@microsoft/microsoft-graph-client';
import { ResponseType } from '@microsoft/microsoft-graph-client';
import {
  describe_graph_error,
  is_retryable_error,
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import { logger } from '@wisecom/atlas-core/utils/logger';

// 30 min per attempt: a MIME body carries its attachments inline and runs to
// Graph's message ceiling, which the default 60s window kills on slow links.
const MIME_DOWNLOAD_TIMEOUT_MS = 1_800_000;

/**
 * Fetches a message's original RFC 5322 MIME via `/$value` — the bytes that
 * transited SMTP, with the Received chain, DKIM/SPF results, threading headers,
 * and any S/MIME payload intact (issue #50). Attachments are embedded, so a
 * MIME capture needs no separate attachment requests.
 *
 * Resolves undefined when Graph permanently refuses MIME for this item (the
 * message was hard-deleted between the delta page and this call, or it is an
 * item type with no MIME representation). The caller then stores the JSON
 * payload instead, so one odd item never costs a whole mailbox.
 */
export async function fetch_message_mime(
  client: Client,
  owner_id: string,
  message_id: string,
  immutable_id_prefer: string,
): Promise<Buffer | undefined> {
  const url = `/users/${owner_id}/messages/${message_id}/$value`;
  try {
    const data = await with_graph_retry(
      () =>
        client
          .api(url)
          .header('Prefer', immutable_id_prefer)
          .responseType(ResponseType.ARRAYBUFFER)
          .get() as Promise<ArrayBuffer>,
      { timeout_ms: MIME_DOWNLOAD_TIMEOUT_MS },
    );
    return Buffer.from(data);
  } catch (err) {
    rethrow_if_mailbox_not_licensed(err);
    rethrow_if_access_denied(err);
    if (is_mime_unavailable_error(err)) {
      logger.debug(`no MIME available for message ${message_id}: ${describe_graph_error(err)}`);
      return undefined;
    }
    throw err;
  }
}

/**
 * True when Graph will never return MIME for this item, however many times we
 * ask: the message is gone, or its type has no MIME representation. Retryable
 * statuses (429/5xx) and network faults are deliberately excluded — those are
 * handled by with_graph_retry and must surface as real failures, not as a
 * silent downgrade to the lossy JSON payload.
 */
function is_mime_unavailable_error(err: unknown): boolean {
  if (is_retryable_error(err)) return false;
  const status = (err as { statusCode?: number } | undefined)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}
