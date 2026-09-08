import { is_transient_error } from '@wisecom/atlas-m365-graph';
import { logger } from '@wisecom/atlas-core/utils/logger';

/** Bytes per chunk PUT into a Graph upload session. */
export const LARGE_UPLOAD_CHUNK = 10 * 1024 * 1024;

const CHUNK_PUT_ATTEMPTS = 3;

async function sleep_ms(delay_ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, delay_ms);
  return promise;
}

/** Reads `Retry-After` in either form RFC 9110 allows: delta-seconds or an HTTP-date. */
function parse_fetch_retry_after_ms(header_value: string | null): number | undefined {
  if (!header_value) return undefined;
  const trimmed = header_value.trim();
  const seconds = parseInt(trimmed, 10);
  if (!isNaN(seconds)) return seconds * 1000;
  const date_ms = Date.parse(trimmed);
  if (!isNaN(date_ms)) {
    const delta = date_ms - Date.now();
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

/**
 * Releases an upload session Atlas is abandoning.
 *
 * A cleanup that itself fails is reported rather than swallowed: the session keeps its reserved
 * quota until Graph expires it, and an operator chasing a quota complaint needs to know Atlas tried
 * and could not (issue #342).
 */
async function cancel_upload_session(upload_url: string, reason: string): Promise<void> {
  try {
    const response = await fetch(upload_url, { method: 'DELETE' });
    if (!response.ok) {
      logger.warn(
        `Could not cancel the upload session after ${reason}: HTTP ${response.status}. ` +
          `It stays reserved until Graph expires it.`,
      );
    }
  } catch (err) {
    logger.warn(
      `Could not cancel the upload session after ${reason}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `It stays reserved until Graph expires it.`,
    );
  }
}

/** What Graph answers an intermediate chunk with, per the createUploadSession contract. */
interface UploadSessionStatus {
  readonly nextExpectedRanges?: string[];
}

/**
 * Uploads a buffer into an open Graph upload session and returns only on a completed item.
 *
 * The completion signal is the status code, not `response.ok`. Graph answers an intermediate chunk
 * with `202 Accepted` and the ranges it still wants, and the final chunk with `200` or `201`
 * carrying the finished `driveItem`. Treating every 2xx as success reported a file as restored when
 * the session was still waiting for bytes, so a truncated or absent file counted as a successful
 * restore (issue #342).
 *
 * An upload still expecting ranges after the last chunk fails the file rather than resuming: the
 * bytes are all in hand, so a session that has not converged is a server-side or protocol problem
 * and retrying the same content into the same session is unlikely to change it. The next restore
 * opens a fresh session.
 */
export async function upload_content_to_session(
  upload_url: string,
  content: Buffer,
  label: string,
): Promise<void> {
  try {
    for (let offset = 0; offset < content.length; offset += LARGE_UPLOAD_CHUNK) {
      const end = Math.min(offset + LARGE_UPLOAD_CHUNK, content.length);
      const range = `bytes ${offset}-${end - 1}/${content.length}`;
      const completed = await put_chunk_with_retry(
        upload_url,
        range,
        content.subarray(offset, end),
      );
      if (completed) {
        if (end < content.length) {
          await cancel_upload_session(upload_url, `an early completion at ${range}`);
          throw new Error(
            `Resumable upload of ${label} completed at ${range} with ` +
              `${content.length - end} byte(s) unsent`,
          );
        }
        return;
      }
    }
  } catch (err) {
    // A thrown error takes the same exit as a terminal HTTP failure. Without this a socket reset on
    // the last chunk left the session open and the file half written.
    await cancel_upload_session(upload_url, 'a failed chunk upload');
    throw err;
  }

  // Every chunk was accepted and none of them completed the item.
  const outstanding = await read_outstanding_ranges(upload_url);
  await cancel_upload_session(upload_url, 'an upload that never completed');
  throw new Error(
    `Resumable upload of ${label} sent every byte but Graph never returned a completed item; ` +
      `it still expects ${outstanding}`,
  );
}

/** Uploads one chunk, returning whether Graph reported the item as complete. */
async function put_chunk_with_retry(
  upload_url: string,
  range: string,
  chunk: Buffer,
): Promise<boolean> {
  for (let attempt = 0; attempt < CHUNK_PUT_ATTEMPTS; attempt++) {
    const response = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Range': range, 'Content-Length': String(chunk.length) },
      body: chunk,
    });
    // 200 and 201 carry the finished driveItem; 202 means the session wants more bytes.
    if (response.status === 200 || response.status === 201) return true;
    if (response.status === 202) return false;

    const detail = await response.text();
    // A range PUT is addressed by Content-Range, so replaying one after a
    // transient 500/502/504 rewrites the same bytes (issue #36).
    const retriable = is_transient_error({ statusCode: response.status });
    if (retriable && attempt < CHUNK_PUT_ATTEMPTS - 1) {
      const wait_ms = parse_fetch_retry_after_ms(response.headers.get('retry-after')) ?? 1000;
      await sleep_ms(wait_ms);
      continue;
    }
    throw new Error(`Resumable upload failed at range ${range}: HTTP ${response.status} ${detail}`);
  }
  throw new Error(`Resumable upload failed at range ${range}: retries exhausted`);
}

/** Asks the session what it is still waiting for, so the failure names it. */
async function read_outstanding_ranges(upload_url: string): Promise<string> {
  try {
    const response = await fetch(upload_url, { method: 'GET' });
    if (!response.ok) return `an unknown range (status query returned HTTP ${response.status})`;
    const status = (await response.json()) as UploadSessionStatus;
    const ranges = status.nextExpectedRanges;
    return ranges && ranges.length > 0 ? ranges.join(', ') : 'an unreported range';
  } catch {
    return 'an unknown range';
  }
}
