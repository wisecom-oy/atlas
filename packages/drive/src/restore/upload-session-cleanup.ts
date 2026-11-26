import { logger } from '@wisecom/atlas-core/utils/logger';

/**
 * How long a request made on the way out of an upload may run: the session DELETE that releases
 * an abandoned session, and the status GET that names what an incomplete session still expects.
 */
export const SESSION_CLEANUP_TIMEOUT_MS = 10_000;

/** What Graph answers an intermediate chunk or a status query with, per the session contract. */
interface UploadSessionStatus {
  readonly nextExpectedRanges?: string[];
}

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
export async function cancel_upload_session(upload_url: string, reason: string): Promise<void> {
  try {
    const status = await request_within_cleanup_deadline(upload_url, 'DELETE', (answer) =>
      Promise.resolve(answer.status),
    );
    if (status < 200 || status > 299) {
      logger.warn(
        `Could not cancel the upload session after ${reason}: HTTP ${status}. ` +
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

/**
 * Asks the session what it is still waiting for, so the failure names it. The query and its body
 * share the cleanup deadline, so a host that stops answering cannot hold the failed file (#878).
 */
export async function read_outstanding_ranges(upload_url: string): Promise<string> {
  try {
    return await request_within_cleanup_deadline(upload_url, 'GET', async (answer) => {
      if (!answer.ok) return `an unknown range (status query returned HTTP ${answer.status})`;
      const status = (await answer.json()) as UploadSessionStatus;
      const ranges = status.nextExpectedRanges;
      return ranges && ranges.length > 0 ? ranges.join(', ') : 'an unreported range';
    });
  } catch {
    return 'an unknown range';
  }
}

/** One request to the session URL, read by `read`; both are aborted once the cleanup deadline passes. */
async function request_within_cleanup_deadline<T>(
  upload_url: string,
  method: 'DELETE' | 'GET',
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error('timed out')),
    SESSION_CLEANUP_TIMEOUT_MS,
  );
  try {
    return await read(await fetch(upload_url, { method, signal: deadline.signal }));
  } finally {
    clearTimeout(timer);
  }
}
