import type { Client } from '@microsoft/microsoft-graph-client';
import type { ExtendedProperty } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  describe_graph_error,
  is_transient_error,
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';

const REACTIONS_PROPERTY_SET = '{41F28F13-83F4-4114-A584-EEDB5A6B0BFF}';

/** The MAPI named properties Exchange stores Outlook reactions in (issue #481). */
const REACTION_PROPERTY_IDS = [
  `String ${REACTIONS_PROPERTY_SET} Name OwnerReactionType`,
  `Binary ${REACTIONS_PROPERTY_SET} Name MapiReactionsBlob`,
  `Binary ${REACTIONS_PROPERTY_SET} Name ReactionsSummary`,
];

const REACTION_EXPAND = `singleValueExtendedProperties($filter=${REACTION_PROPERTY_IDS.map(
  (id) => `id eq '${id}'`,
).join(' or ')})`;

/** Graph's ceiling on requests in one `$batch`. */
const BATCH_LIMIT = 20;

/** Graph answers a request whose `dependsOn` predecessor failed with 424; it never ran. */
const FAILED_DEPENDENCY = 424;

interface BatchResponse {
  readonly id: string;
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: {
    readonly singleValueExtendedProperties?: ExtendedProperty[];
    readonly error?: { readonly code?: string; readonly message?: string };
  };
}

/**
 * Reads the reaction properties of many messages, 20 per `$batch` round trip instead of one
 * `GET /messages/{id}` each (issue #513). The delta query rejects this `$expand` with 400, so it
 * cannot ride along on the delta page.
 *
 * A message missing from the result could not be read; the reason is logged. Access and
 * licensing failures throw, as for every other mailbox read.
 */
export async function fetch_message_reaction_properties(
  client: Client,
  owner_id: string,
  message_ids: readonly string[],
  immutable_id_prefer: string,
): Promise<Map<string, ExtendedProperty[]>> {
  const found = new Map<string, ExtendedProperty[]>();
  for (let start = 0; start < message_ids.length; start += BATCH_LIMIT) {
    const chunk = message_ids.slice(start, start + BATCH_LIMIT);
    try {
      await read_chunk(client, owner_id, chunk, immutable_id_prefer, found);
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      const unread = chunk.filter((id) => !found.has(id)).length;
      logger.warn(`Reaction capture failed for ${unread} messages: ${describe_graph_error(err)}`);
    }
  }
  return found;
}

/**
 * Sends one chunk until every message is read or has failed for good. Each pass resends only the
 * messages still pending, so a retry after a throttle never re-reads a settled one.
 */
async function read_chunk(
  client: Client,
  owner_id: string,
  chunk: readonly string[],
  immutable_id_prefer: string,
  found: Map<string, ExtendedProperty[]>,
): Promise<void> {
  let pending = [...chunk];
  await with_graph_retry(async () => {
    while (pending.length > 0) {
      const responses = await post_sequential_batch(client, owner_id, pending, immutable_id_prefer);
      const settled = settle_responses(pending, responses, found);
      const made_progress = settled.still_pending.length < pending.length;
      pending = settled.still_pending;
      // The head of the chain always runs, so a pass that settled nothing is retried as transient.
      if (settled.transient || !made_progress) throw settled.transient ?? to_graph_error(undefined);
    }
  });
}

/**
 * Posts the reads chained with `dependsOn`, so Exchange runs them one at a time. A parallel batch
 * of 20 against one mailbox exceeds Outlook's 4 concurrent requests per mailbox and comes back
 * mostly 429.
 */
async function post_sequential_batch(
  client: Client,
  owner_id: string,
  message_ids: readonly string[],
  immutable_id_prefer: string,
): Promise<BatchResponse[]> {
  const query = `$select=id&$expand=${encodeURIComponent(REACTION_EXPAND)}`;
  const requests = message_ids.map((message_id, index) => ({
    id: String(index),
    method: 'GET',
    url: `/users/${owner_id}/messages/${encodeURIComponent(message_id)}?${query}`,
    headers: { Prefer: immutable_id_prefer },
    ...(index > 0 ? { dependsOn: [String(index - 1)] } : {}),
  }));
  const response = (await client.api('/$batch').post({ requests })) as {
    responses?: BatchResponse[];
  };
  return response.responses ?? [];
}

/**
 * Records each read and returns the ids still to send: throttled, server-failed, or skipped (424)
 * behind a failure, plus the first transient error so the caller backs off before resending. A
 * message Graph refused for good (404 and the like) is logged and dropped. Throws on an access or
 * licensing failure, which no retry fixes.
 */
function settle_responses(
  pending: readonly string[],
  responses: readonly BatchResponse[],
  found: Map<string, ExtendedProperty[]>,
): { still_pending: string[]; transient: Error | undefined } {
  const by_request = new Map(responses.map((r) => [r.id, r]));
  const still_pending: string[] = [];
  let transient: Error | undefined;

  pending.forEach((message_id, index) => {
    const response = by_request.get(String(index));
    if (response?.status === 200) {
      const properties = response.body?.singleValueExtendedProperties ?? [];
      found.set(
        message_id,
        properties.map(({ id, value }) => ({ id, value })),
      );
      return;
    }
    const err = to_graph_error(response);
    if (
      response === undefined ||
      response.status === FAILED_DEPENDENCY ||
      is_transient_error(err)
    ) {
      still_pending.push(message_id);
      if (response?.status !== FAILED_DEPENDENCY) transient ??= err;
      return;
    }
    rethrow_if_mailbox_not_licensed(err);
    if (response.status === 403) throw err;
    logger.warn(`Reaction capture failed for message ${message_id}: ${describe_graph_error(err)}`);
  });

  return { still_pending, transient };
}

/** Shapes a batch sub-response like the Graph SDK's own errors, so the shared helpers read it. */
function to_graph_error(response: BatchResponse | undefined): Error {
  if (response === undefined) {
    return Object.assign(new Error('Graph $batch returned no response for the request'), {
      statusCode: 503,
    });
  }
  const error = response.body?.error;
  return Object.assign(new Error(error?.message ?? ''), {
    statusCode: response.status,
    code: error?.code,
    headers: response.headers ?? {},
  });
}
