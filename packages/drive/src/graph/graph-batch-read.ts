import type { GraphApiClient } from '@/permissions/graph-api-client';
import {
  describe_graph_error,
  is_transient_error,
  rethrow_if_retry_exhausted,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { logger } from '@wisecom/atlas-core/utils/logger';

/** Graph's ceiling on requests in one `$batch`. */
export const BATCH_LIMIT = 20;

/** One read in a batch: the key the result is filed under, and the Graph path to GET. */
export interface BatchReadRequest {
  readonly key: string;
  readonly url: string;
}

/** Where a call files what it read and what Graph refused. */
interface BatchReadOutcome<T> {
  readonly found: Map<string, T>;
  readonly refusals: Refusals;
}

/** How a batched read names itself in log lines, and turns a 200 body into its result. */
export interface BatchReadSpec<T> {
  /** What is being read, for log lines, such as `Permission capture`. Never an id. */
  readonly label: string;
  readonly read_body: (body: Record<string, unknown>) => Promise<T> | T;
}

/** Requests Graph refused for good during one call, reported as one log line. */
interface Refusals {
  count: number;
  first?: string;
}

interface BatchResponse {
  readonly id: string;
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: Record<string, unknown> & {
    readonly error?: { readonly code?: string; readonly message?: string };
  };
}

/**
 * Sends each GET through `POST /$batch`, 20 to a round trip, and returns the result of every one
 * that answered 200, by key.
 *
 * A request missing from the result could not be read: Graph refused it for good (a 404 for an
 * item deleted since the delta page, a 403 and the like), or its chunk kept failing after the
 * retry budget. Both are logged, never thrown, so a metadata read never fails the content backup it
 * rides along with; a caller that must not lose the read records the missing keys (issue #856).
 * Refusals are summed into one line per call, so a drive that refuses every read logs once rather
 * than once per item. Cancellation still propagates, and so does an exhausted
 * retry budget: it is a Graph outage, and swallowing it would store the drive's items without their
 * metadata while the remaining chunks met the same outage (issue #881).
 */
export async function batch_read_each<T>(
  client: GraphApiClient,
  requests: readonly BatchReadRequest[],
  spec: BatchReadSpec<T>,
): Promise<Map<string, T>> {
  const found = new Map<string, T>();
  const refusals: Refusals = { count: 0 };
  for (let start = 0; start < requests.length; start += BATCH_LIMIT) {
    const chunk = requests.slice(start, start + BATCH_LIMIT);
    try {
      await read_chunk(client, chunk, spec, { found, refusals });
    } catch (err) {
      if (is_active_run_cancelled()) throw err;
      rethrow_if_retry_exhausted(err);
      const unread = chunk.filter((request) => !found.has(request.key)).length;
      logger.warn(`${spec.label} failed for ${unread} item(s): ${describe_graph_error(err)}`);
    }
  }
  if (refusals.count > 0) {
    logger.warn(`${spec.label} skipped ${refusals.count} item(s) Graph refused: ${refusals.first}`);
  }
  return found;
}

/**
 * Sends one chunk until every request is read or has failed for good. Each pass resends only the
 * requests still pending, so a retry after a throttle never re-reads a settled one.
 */
async function read_chunk<T>(
  client: GraphApiClient,
  chunk: readonly BatchReadRequest[],
  spec: BatchReadSpec<T>,
  outcome: BatchReadOutcome<T>,
): Promise<void> {
  let pending = [...chunk];
  await with_graph_retry(async () => {
    while (pending.length > 0) {
      const responses = await post_batch(client, pending);
      const settled = await settle_responses(pending, responses, spec, outcome);
      const made_progress = settled.still_pending.length < pending.length;
      pending = settled.still_pending;
      if (settled.transient || (!made_progress && pending.length > 0)) {
        throw settled.transient ?? to_graph_error(undefined);
      }
    }
  });
}

async function post_batch(
  client: GraphApiClient,
  pending: readonly BatchReadRequest[],
): Promise<BatchResponse[]> {
  const requests = pending.map((request, index) => ({
    id: String(index),
    method: 'GET',
    url: request.url,
  }));
  const response = (await client.api('/$batch').post({ requests })) as {
    responses?: BatchResponse[];
  };
  return response.responses ?? [];
}

/**
 * Records each read and returns the requests still to send (throttled or server-failed), plus the
 * first transient error so the caller backs off before resending. A request Graph refused for good
 * is counted and dropped. A body reader that fails (such as a later page of a paged result) settles
 * only its own request the same way, so the other reads in the batch are kept.
 */
async function settle_responses<T>(
  pending: readonly BatchReadRequest[],
  responses: readonly BatchResponse[],
  spec: BatchReadSpec<T>,
  outcome: BatchReadOutcome<T>,
): Promise<{ still_pending: BatchReadRequest[]; transient: Error | undefined }> {
  const by_request = new Map(responses.map((r) => [r.id, r]));
  const still_pending: BatchReadRequest[] = [];
  let transient: Error | undefined;

  for (const [index, request] of pending.entries()) {
    const response = by_request.get(String(index));
    const err = await record_read(request, response, spec, outcome);
    if (err === undefined) continue;
    if (response === undefined || is_transient_error(err)) {
      still_pending.push(request);
      transient ??= err;
      continue;
    }
    outcome.refusals.count++;
    outcome.refusals.first ??= describe_graph_error(err);
  }
  return { still_pending, transient };
}

/**
 * Files a 200 response's result under its key and returns undefined, or returns the error that
 * kept this request from being read: the sub-response's own, or the one its body reader threw.
 */
async function record_read<T>(
  request: BatchReadRequest,
  response: BatchResponse | undefined,
  spec: BatchReadSpec<T>,
  outcome: BatchReadOutcome<T>,
): Promise<Error | undefined> {
  if (response?.status !== 200) return to_graph_error(response);
  try {
    outcome.found.set(request.key, await spec.read_body(response.body ?? {}));
    return undefined;
  } catch (err) {
    if (is_active_run_cancelled()) throw err;
    return err instanceof Error ? err : new Error(String(err));
  }
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
