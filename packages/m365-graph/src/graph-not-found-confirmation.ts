/**
 * When a "not found" answer on a run's first read is believed, within the same run.
 *
 * The first request of a run for one owner (the mailbox existence check, the drive listing, the
 * calendar or contact folder listing) decides whether the run happens at all. `with_graph_retry`
 * never repeats a 4xx, and Graph answers 404 for objects that exist while a directory or mailbox
 * replica lags, so one answer used to end the run with exit `7` (issues #862, #863 and #864).
 *
 * The rule: a 4xx that another layer does not already classify is read again, twice, 2 s and
 * then 4 s later. A 404 that persists through all three reads is passed to the caller, which may
 * accept it as absence. Any other 4xx that persists is reported as `GraphUnavailableError`, so it
 * ends with the retryable exit `3` instead of an unclassified exit `1`. A caller names the answers
 * that are conclusive on the first read, such as OneDrive's "User's mysite not found.", and those
 * are never repeated.
 *
 * This is the in-run counterpart of `not-found-streak.ts` in core, which spreads its confirming
 * reads over several runs because the decision there deletes stored data.
 */

import { get_active_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import { sleep } from '@/graph-attempt-cancellation';
import { describe_graph_error } from '@/graph-request-error-handler';

/** Waits before each repeated read: three reads in all, about 6 s from first to last. */
export const NOT_FOUND_REREAD_DELAYS_MS: readonly number[] = [2_000, 4_000];

/**
 * 4xx statuses this rule never repeats, because another layer owns them: the shared request path
 * retries a refused token (401), `rethrow_if_access_denied` classifies a 403 by its code, and
 * `with_graph_retry` retries a 429.
 */
const CLASSIFIED_ELSEWHERE: ReadonlySet<number> = new Set([401, 403, 429]);

/** Graph codes that are conclusive wherever they appear: the mailbox has no licence for the API. */
const ALWAYS_CONCLUSIVE_CODES: ReadonlySet<string> = new Set(['mailboxnotenabledforrestapi']);

/** True for the answers a caller accepts on the first read. */
export type ConclusiveAnswer = (err: unknown) => boolean;

/**
 * Runs `read`, and runs it again after a 4xx no other layer classifies, up to the rule's limit.
 *
 * @throws the last 404 unchanged when every read answered 404 and none was conclusive.
 * @throws GraphUnavailableError when another 4xx persisted through every read.
 * @throws any other failure, and a conclusive answer, from the read that produced it.
 */
export async function read_confirming_not_found<T>(
  read: () => Promise<T>,
  is_conclusive: ConclusiveAnswer = () => false,
): Promise<T> {
  const started_at = Date.now();
  for (let reread = 0; ; reread++) {
    try {
      return await read();
    } catch (err) {
      if (!is_doubtful_answer(err) || is_conclusive(err)) throw err;
      const delay_ms = NOT_FOUND_REREAD_DELAYS_MS[reread];
      if (delay_ms === undefined) throw persistent_answer_error(err, reread, started_at);
      logger.debug(
        `Reading again in ${delay_ms / 1000} s to confirm ${describe_graph_error(err)} ` +
          `(${reread + 1}/${NOT_FOUND_REREAD_DELAYS_MS.length})`,
      );
      await sleep(delay_ms, get_active_abort_signal());
    }
  }
}

/** The HTTP status a Graph error carries on `statusCode`, or undefined for any other failure. */
export function graph_status_of(err: unknown): number | undefined {
  const status = field_of(err, 'statusCode');
  return typeof status === 'number' ? status : undefined;
}

/**
 * Builds the `GraphUnavailableError` for an answer that persisted through every read without being
 * accepted: the request is one Graph answers for an owner that exists, so a later run can succeed.
 */
export function unconfirmed_answer_error(
  err: unknown,
  rereads: number,
  started_at: number,
): GraphUnavailableError {
  const elapsed_ms = Date.now() - started_at;
  const code = field_of(err, 'code');
  return new GraphUnavailableError(
    `Microsoft Graph kept answering ${describe_graph_error(err)} on ${rereads + 1} reads over ` +
      `${Math.round(elapsed_ms / 1000)} s, to a request it answers for an owner that exists. ` +
      `Run the command again later.`,
    { retries: rereads, elapsed_ms },
    {
      status_code: graph_status_of(err),
      graph_code: typeof code === 'string' && code !== '' ? code : undefined,
      cause: err,
    },
  );
}

/** A 4xx no other layer classifies, and that no always-conclusive code marks as final. */
function is_doubtful_answer(err: unknown): boolean {
  const status = graph_status_of(err);
  if (status === undefined || status < 400 || status > 499) return false;
  if (CLASSIFIED_ELSEWHERE.has(status)) return false;
  const code = field_of(err, 'code');
  return !(typeof code === 'string' && ALWAYS_CONCLUSIVE_CODES.has(code.toLowerCase()));
}

/** The failure to throw once the reads are spent: the 404 itself, or the classified other 4xx. */
function persistent_answer_error(err: unknown, rereads: number, started_at: number): unknown {
  if (graph_status_of(err) === 404) return err;
  return unconfirmed_answer_error(err, rereads, started_at);
}

/** One field of an error object, or undefined for anything else. */
function field_of(err: unknown, key: string): unknown {
  return typeof err === 'object' && err !== null && key in err
    ? (err as Record<string, unknown>)[key]
    : undefined;
}
