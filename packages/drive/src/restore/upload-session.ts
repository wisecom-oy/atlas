import {
  cancellable_sleep,
  is_transient_error,
  parse_retry_after_ms,
  report_transfer_throttle,
  wait_for_transfer_slot,
} from '@wisecom/atlas-m365-graph';
import { ByteQueue } from '@wisecom/atlas-core/services/shared/byte-queue';
import { get_active_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { LargeFileContent, StreamedFileContent } from '@wisecom/atlas-types';

/** Bytes per chunk PUT into a Graph upload session. */
export const LARGE_UPLOAD_CHUNK = 10 * 1024 * 1024;

const CHUNK_PUT_ATTEMPTS = 3;

/** How long releasing an abandoned session may hold up the run that is giving it up. */
export const SESSION_CLEANUP_TIMEOUT_MS = 10_000;

/**
 * Releases an upload session Atlas is abandoning.
 *
 * A cleanup that itself fails is reported rather than swallowed: the session keeps its reserved
 * quota until Graph expires it, and an operator chasing a quota complaint needs to know Atlas tried
 * and could not (issue #342).
 *
 * The DELETE gets its own deadline. It runs on the way out of a failed or cancelled upload, so an
 * endpoint that never answers would otherwise hold back the interrupted result Ctrl+C asked for
 * (issue #682). A session left behind this way expires on Graph's side without creating a file.
 */
async function cancel_upload_session(upload_url: string, reason: string): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error('timed out')),
    SESSION_CLEANUP_TIMEOUT_MS,
  );
  try {
    const response = await fetch(upload_url, { method: 'DELETE', signal: deadline.signal });
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
  } finally {
    clearTimeout(timer);
  }
}

/** What Graph answers an intermediate chunk with, per the createUploadSession contract. */
interface UploadSessionStatus {
  readonly nextExpectedRanges?: string[];
}

/**
 * Uploads a file into an open Graph upload session and returns only on a completed item.
 *
 * The completion signal is the status code, not `response.ok`. Graph answers an intermediate chunk
 * with `202 Accepted` and the ranges it still wants, and the final chunk with `200` or `201`
 * carrying the finished `driveItem`. Treating every 2xx as success reported a file as restored when
 * the session was still waiting for bytes, so a truncated or absent file counted as a successful
 * restore (issue #342).
 *
 * A streamed source is uploaded as it arrives, so restoring a large file holds two chunks rather
 * than the whole plaintext (issue #343). One chunk is always held back until the source has ended:
 * the final PUT is what creates the item, so a source that fails late, an AES-GCM tag that does not
 * authenticate or a checksum that does not match the manifest, leaves an abandoned session instead
 * of a file. That is what lets a decrypt stream hand over unverified bytes at all.
 *
 * An upload still expecting ranges after the last chunk fails the file rather than resuming: the
 * bytes are all in hand, so a session that has not converged is a server-side or protocol problem
 * and retrying the same content into the same session is unlikely to change it. The next restore
 * opens a fresh session.
 */
export async function upload_content_to_session(
  upload_url: string,
  content: LargeFileContent,
  label: string,
): Promise<void> {
  const source: StreamedFileContent = Buffer.isBuffer(content)
    ? { chunks: [content], total_bytes: content.length }
    : content;

  // Ctrl+C ends an intermediate chunk PUT or any retry wait, which leaves an abandoned session and
  // no file. The committing chunk is never cut off mid-flight: Graph may already have accepted it,
  // and an upload that then reported itself cancelled could hide a file it had written (#682).
  const abort_signal = get_active_abort_signal();
  let outcome: UploadOutcome;
  try {
    outcome = await put_source_chunks(upload_url, source, label, abort_signal);
  } catch (err) {
    // A thrown error takes the same exit as a terminal HTTP failure. Without this a socket reset on
    // a chunk, or a source that failed to authenticate, left the session open.
    const reason = abort_signal?.aborted === true ? 'a cancelled run' : 'a failed chunk upload';
    await cancel_upload_session(upload_url, reason);
    throw err;
  }

  if (outcome.kind === 'completed') return;

  if (outcome.kind === 'early') {
    // Graph removed the session when it returned the item, so there is nothing left to cancel, and
    // the item it created stays. Reaching this means Graph answered a chunk that was not the last
    // one with a terminal status, against its own contract, so the file at the target is short and
    // was assembled from bytes this upload had not finished verifying.
    throw new Error(
      `Resumable upload of ${label} was completed by Graph at ${outcome.range} with ` +
        `${outcome.unsent} byte(s) unsent; a partial, unverified file now exists at the target ` +
        `and has to be removed by hand`,
    );
  }

  const outstanding = await read_outstanding_ranges(upload_url);
  await cancel_upload_session(upload_url, 'an upload that never completed');
  throw new Error(
    `Resumable upload of ${label} sent every byte but Graph never returned a completed item; ` +
      `it still expects ${outstanding}`,
  );
}

/** How a session answered the last chunk it was given. */
type UploadOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'early'; readonly range: string; readonly unsent: number }
  | { readonly kind: 'incomplete' };

/** Sends the source into the session, holding the committing chunk back until the source ends. */
async function put_source_chunks(
  upload_url: string,
  source: StreamedFileContent,
  label: string,
  abort_signal: AbortSignal | undefined,
): Promise<UploadOutcome> {
  const pending = new ByteQueue();
  let sent = 0;

  for await (const chunk of source.chunks) {
    pending.push(chunk);
    // Strictly greater, so a source that ends on a chunk boundary still leaves a full chunk for the
    // committing PUT below.
    while (pending.bytes > LARGE_UPLOAD_CHUNK) {
      const block = pending.take(LARGE_UPLOAD_CHUNK);
      // Holding bytes back is not enough on its own: Graph commits as soon as the ranges it has
      // received cover the declared total, and the total comes from the manifest rather than from
      // the source. A source longer than the manifest recorded would therefore commit here, while
      // the tag and the digest are still unchecked, so it fails instead.
      if (sent + block.length >= source.total_bytes) {
        throw new Error(
          `Resumable upload of ${label} has more content than the ${source.total_bytes} byte(s) ` +
            `recorded for it; refusing to complete the session with unverified bytes`,
        );
      }
      const range = `bytes ${sent}-${sent + block.length - 1}/${source.total_bytes}`;
      if (await put_chunk_with_retry(upload_url, range, block, abort_signal)) {
        return { kind: 'early', range, unsent: source.total_bytes - sent - block.length };
      }
      sent += block.length;
    }
  }

  // The source ended without throwing, so everything it produced carries an authenticated tag and a
  // digest that matched, and whatever is still pending is what creates the item.
  const streamed = sent + pending.bytes;
  if (streamed !== source.total_bytes) {
    throw new Error(
      `Resumable upload of ${label} verified ${streamed} byte(s), but the manifest recorded ` +
        `${source.total_bytes} and the session was opened for that`,
    );
  }

  // The loop above only drains while strictly more than one chunk is pending, so at most one chunk
  // is left and this single PUT is the one that creates the item.
  if (pending.bytes > 0) {
    const range = `bytes ${sent}-${source.total_bytes - 1}/${source.total_bytes}`;
    const last = pending.take(pending.bytes);
    if (await put_chunk_with_retry(upload_url, range, last, abort_signal, 'commit')) {
      return { kind: 'completed' };
    }
  }

  return { kind: 'incomplete' };
}

/** Uploads one chunk, returning whether Graph reported the item as complete. */
async function put_chunk_with_retry(
  upload_url: string,
  range: string,
  chunk: Buffer,
  abort_signal: AbortSignal | undefined,
  role: 'intermediate' | 'commit' = 'intermediate',
): Promise<boolean> {
  // The waits before a send stay cancellable either way; only the committing request runs to its end.
  const request_signal = role === 'commit' ? undefined : abort_signal;
  for (let attempt = 0; attempt < CHUNK_PUT_ATTEMPTS; attempt++) {
    await wait_for_transfer_slot(abort_signal);
    const response = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Range': range, 'Content-Length': String(chunk.length) },
      body: chunk,
      ...(request_signal ? { signal: request_signal } : {}),
    });
    report_transfer_throttle(response);
    // 200 and 201 carry the finished driveItem; 202 means the session wants more bytes.
    if (response.status === 200 || response.status === 201) return true;
    if (response.status === 202) return false;

    const detail = await response.text();
    // A range PUT is addressed by Content-Range, so replaying one after a
    // transient 500/502/504 rewrites the same bytes (issue #36).
    const retriable = is_transient_error({ statusCode: response.status });
    if (retriable && attempt < CHUNK_PUT_ATTEMPTS - 1) {
      // The shared parser: the private `parseInt` copy this replaces had no clamp, so a value
      // above 2^31-1 ms overflowed `setTimeout` and retried after about 1 ms (issue #628).
      const wait_ms = parse_retry_after_ms(response.headers.get('retry-after')) ?? 1000;
      await cancellable_sleep(wait_ms, abort_signal);
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
