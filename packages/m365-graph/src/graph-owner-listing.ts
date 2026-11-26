/**
 * The existence check and first listing of a run for one owner, read under the in-run
 * confirmation rule of `graph-not-found-confirmation.ts`.
 *
 * A listing that answers 404 on every read says only that the listing could not be read. It is put
 * down to the owner's absence when the owner's directory record answers 404 on every read too, and
 * to Graph otherwise, so a scheduler retries an owner that exists and stops on one that is gone.
 */

import type { Client } from '@microsoft/microsoft-graph-client';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { NotFoundError } from '@wisecom/atlas-types';
import {
  NOT_FOUND_REREAD_DELAYS_MS,
  graph_status_of,
  read_confirming_not_found,
  unconfirmed_answer_error,
  type ConclusiveAnswer,
} from '@/graph-not-found-confirmation';
import { describe_graph_error, with_graph_retry } from '@/graph-request-error-handler';

/** What one owner listing reads, for the messages that name it. */
export interface OwnerListing {
  readonly owner_id: string;
  /** What the listing returns, e.g. `calendars` or `drives`. */
  readonly listing: string;
  /** Answers accepted on the first read, never repeated. */
  readonly is_conclusive?: ConclusiveAnswer;
}

/**
 * Whether the directory knows the user, from `GET /users/{id}?$select=id`. False only after the
 * 404 persisted through every read of the confirmation rule.
 *
 * @throws any other failure, such as a 403, for the caller to classify.
 */
export async function read_user_exists(client: Client, owner_id: string): Promise<boolean> {
  try {
    await read_confirming_not_found(() =>
      with_graph_retry((signal) =>
        client
          .api(`/users/${encodeURIComponent(owner_id)}?$select=id`)
          .option('signal', signal)
          .get(),
      ),
    );
    return true;
  } catch (err) {
    if (graph_status_of(err) === 404) return false;
    throw err;
  }
}

/**
 * Runs an owner's first listing under the confirmation rule.
 *
 * @throws NotFoundError when the listing and the owner's directory record both answered 404 on
 *   every read.
 * @throws GraphUnavailableError when the listing kept answering 404 for an owner the directory
 *   still knows, or another 4xx persisted.
 */
export async function read_owner_listing<T>(
  client: Client,
  target: OwnerListing,
  read: () => Promise<T>,
): Promise<T> {
  const is_conclusive = target.is_conclusive ?? ((): boolean => false);
  const started_at = Date.now();
  try {
    return await read_confirming_not_found(read, is_conclusive);
  } catch (err) {
    if (graph_status_of(err) !== 404 || is_conclusive(err)) throw err;
    throw await classify_persistent_not_found(client, target, err, started_at);
  }
}

/** The error for a listing that answered 404 on every read: absence if the owner is gone too. */
async function classify_persistent_not_found(
  client: Client,
  target: OwnerListing,
  err: unknown,
  started_at: number,
): Promise<Error> {
  if (await is_owner_confirmed_absent(client, target.owner_id)) {
    return new NotFoundError(
      `"${target.owner_id}" does not exist in the tenant: Microsoft Graph answered 404 for the ` +
        `user and for its ${target.listing} on every read. Verify the owner and try again.`,
      { cause: err },
    );
  }
  return unconfirmed_answer_error(err, NOT_FOUND_REREAD_DELAYS_MS.length, started_at);
}

/**
 * True when the owner's directory record answered 404 on every read. A check that fails another
 * way, such as a 403 when the app holds no `User.Read.All`, proves nothing, so the listing's 404
 * is reported as Graph's.
 */
async function is_owner_confirmed_absent(client: Client, owner_id: string): Promise<boolean> {
  try {
    return !(await read_user_exists(client, owner_id));
  } catch (err) {
    logger.debug(`Could not check whether ${owner_id} exists: ${describe_graph_error(err)}`);
    return false;
  }
}
