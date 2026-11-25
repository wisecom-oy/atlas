import type { Client } from '@microsoft/microsoft-graph-client';
import {
  cancellable_sleep,
  describe_graph_error,
  get_graph_bytes,
  is_permanent_item_error,
  is_retryable_error,
  read_graph_error_code,
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { get_active_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { MimeUnavailableError } from '@wisecom/atlas-types';

// 30 min per attempt: a MIME body carries its attachments inline and runs to
// Graph's message ceiling, which the default 60s window kills on slow links.
const MIME_DOWNLOAD_TIMEOUT_MS = 1_800_000;
/** Requests per message when `$value` keeps answering 2xx with no body (issue #848). */
const EMPTY_BODY_ATTEMPTS = 3;
/** Wait before asking again for a body that came back empty, multiplied by the attempt number. */
const EMPTY_BODY_RETRY_DELAY_MS = 2_000;

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
 *
 * Rejects with `MimeUnavailableError` when Exchange refuses the conversion for good with a 5xx,
 * such as `500 ErrorMimeContentConversionFailed`, so the caller can record why (issue #812).
 * Rejects when every attempt answered with an empty body, which is never an RFC 5322 message
 * (issue #848).
 */
export async function fetch_message_mime(
  client: Client,
  owner_id: string,
  message_id: string,
  immutable_id_prefer: string,
): Promise<Buffer | undefined> {
  const url = `/users/${owner_id}/messages/${message_id}/$value`;
  try {
    return await download_non_empty_mime(client, url, immutable_id_prefer, message_id);
  } catch (err) {
    rethrow_if_mailbox_not_licensed(err);
    rethrow_if_access_denied(err);
    if (is_permanent_item_error(err)) {
      throw new MimeUnavailableError(describe_graph_error(err), read_graph_error_code(err), {
        cause: err,
      });
    }
    if (is_mime_unavailable_error(err)) {
      logger.debug(`no MIME available for message ${message_id}: ${describe_graph_error(err)}`);
      return undefined;
    }
    throw err;
  }
}

/**
 * Downloads `/$value`, asking again when Graph answers 2xx with an empty body. A transient fault
 * answers that way, and storing the zero bytes would pass as a captured message (issue #848).
 * Rejects once all attempts came back empty. A body shorter than its `Content-Length` never gets
 * here: fetch rejects it as a terminated transfer, which `with_graph_retry` retries.
 */
async function download_non_empty_mime(
  client: Client,
  url: string,
  immutable_id_prefer: string,
  message_id: string,
): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    const mime = await download_mime_once(client, url, immutable_id_prefer);
    if (mime.length > 0) return mime;
    if (attempt === EMPTY_BODY_ATTEMPTS) {
      throw new Error(`Graph returned an empty MIME body on ${EMPTY_BODY_ATTEMPTS} attempts`);
    }
    logger.debug(`empty MIME body for message ${message_id}, attempt ${attempt}; asking again`);
    await cancellable_sleep(EMPTY_BODY_RETRY_DELAY_MS * attempt, get_active_abort_signal());
  }
}

/** One `/$value` download under the Graph retry policy for transient statuses and transport. */
async function download_mime_once(
  client: Client,
  url: string,
  immutable_id_prefer: string,
): Promise<Buffer> {
  const data = await with_graph_retry(
    () => get_graph_bytes(client.api(url).header('Prefer', immutable_id_prefer)),
    { timeout_ms: MIME_DOWNLOAD_TIMEOUT_MS },
  );
  return Buffer.from(data);
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
