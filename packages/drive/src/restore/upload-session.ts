import { UploadCommitUnknownError } from '@wisecom/atlas-types';
import { ByteQueue } from '@wisecom/atlas-core/services/shared/byte-queue';
import { get_active_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import type { LargeFileContent, StreamedFileContent } from '@wisecom/atlas-types';
import { put_chunk_with_retry } from '@/restore/upload-session-chunk';
import { cancel_upload_session, read_outstanding_ranges } from '@/restore/upload-session-cleanup';

export { SESSION_CLEANUP_TIMEOUT_MS } from '@/restore/upload-session-cleanup';

/** Bytes per chunk PUT into a Graph upload session. */
export const LARGE_UPLOAD_CHUNK = 10 * 1024 * 1024;

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
): Promise<string | undefined> {
  const source: StreamedFileContent = Buffer.isBuffer(content)
    ? { chunks: [content], total_bytes: content.length }
    : content;

  // Ctrl+C ends an intermediate chunk PUT or any retry wait, which leaves an abandoned session and
  // no file. The committing chunk is never cut off mid-flight: Graph may already have accepted it,
  // and an upload that then reported itself cancelled could hide a file it had written (#682). Its
  // per-attempt deadline is what bounds it instead (#878).
  const abort_signal = get_active_abort_signal();
  let outcome: UploadOutcome;
  try {
    outcome = await put_source_chunks(upload_url, source, label, abort_signal);
  } catch (err) {
    // A thrown error takes the same exit as a terminal HTTP failure. Without this a socket reset on
    // a chunk, or a source that failed to authenticate, left the session open.
    await cancel_upload_session(upload_url, abandon_reason(err, abort_signal));
    throw err;
  }

  if (outcome.kind === 'completed') return outcome.item_id;

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
  | { readonly kind: 'completed'; readonly item_id: string | undefined }
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
      if ((await put_chunk_with_retry(upload_url, range, block, abort_signal)).completed) {
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
    const answer = await put_chunk_with_retry(upload_url, range, last, abort_signal, 'commit');
    if (answer.completed) return { kind: 'completed', item_id: answer.item_id };
  }

  return { kind: 'incomplete' };
}

/** Why a session is being released after a thrown error, for the cleanup warning. */
function abandon_reason(err: unknown, abort_signal: AbortSignal | undefined): string {
  if (err instanceof UploadCommitUnknownError) return 'a final chunk with an unknown outcome';
  return abort_signal?.aborted === true ? 'a cancelled run' : 'a failed chunk upload';
}
