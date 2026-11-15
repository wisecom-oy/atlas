import type { GraphApiClient } from '@/permissions/graph-api-client';
import type { DrivePermission } from '@wisecom/atlas-types';
import {
  describe_graph_error,
  is_transient_error,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { append_all } from '@wisecom/atlas-core/utils/append-all';
import { sanitize_graph_permissions } from '@/permissions/permission-sanitizer';

/** Graph's ceiling on requests in one `$batch`. */
const BATCH_LIMIT = 20;

interface PermissionPage {
  readonly value?: unknown[];
  readonly '@odata.nextLink'?: string;
}

interface BatchResponse {
  readonly id: string;
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: PermissionPage & {
    readonly error?: { readonly code?: string; readonly message?: string };
  };
}

/**
 * Reads the non-inherited permissions of each item, 20 items to a `$batch` round trip rather than
 * one `GET /permissions` each, which on a large drive would let permission reads dominate the
 * Graph budget.
 *
 * An item missing from the result could not be read: it was deleted meanwhile, or Graph refused it.
 * The reason is logged, and the caller treats the item as "not read", never as "no permissions". A
 * batch that keeps failing after the retry budget is logged too, so a sharing read never fails
 * the content backup it rides along with. Cancellation still propagates.
 */
export async function fetch_drive_item_permissions(
  client: GraphApiClient,
  drive_id: string,
  item_ids: readonly string[],
): Promise<Map<string, DrivePermission[]>> {
  const found = new Map<string, DrivePermission[]>();
  for (let start = 0; start < item_ids.length; start += BATCH_LIMIT) {
    const chunk = item_ids.slice(start, start + BATCH_LIMIT);
    try {
      await read_chunk(client, drive_id, chunk, found);
    } catch (err) {
      if (is_active_run_cancelled()) throw err;
      const unread = chunk.filter((id) => !found.has(id)).length;
      logger.warn(`Permission capture failed for ${unread} item(s): ${describe_graph_error(err)}`);
    }
  }
  return found;
}

/**
 * Sends one chunk until every item is read or has failed for good. Each pass resends only the
 * items still pending, so a retry after a throttle never re-reads a settled one.
 */
async function read_chunk(
  client: GraphApiClient,
  drive_id: string,
  chunk: readonly string[],
  found: Map<string, DrivePermission[]>,
): Promise<void> {
  let pending = [...chunk];
  await with_graph_retry(async () => {
    while (pending.length > 0) {
      const responses = await post_batch(client, drive_id, pending);
      const settled = await settle_responses(client, pending, responses, found);
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
  drive_id: string,
  item_ids: readonly string[],
): Promise<BatchResponse[]> {
  const requests = item_ids.map((item_id, index) => ({
    id: String(index),
    method: 'GET',
    url: `/drives/${drive_id}/items/${item_id}/permissions`,
  }));
  const response = (await client.api('/$batch').post({ requests })) as {
    responses?: BatchResponse[];
  };
  return response.responses ?? [];
}

/**
 * Records each read and returns the items still to send (throttled or server-failed), plus the
 * first transient error so the caller backs off before resending. An item Graph refused for good
 * (404 for an item deleted since the delta page, 403 and the like) is logged and dropped.
 */
async function settle_responses(
  client: GraphApiClient,
  pending: readonly string[],
  responses: readonly BatchResponse[],
  found: Map<string, DrivePermission[]>,
): Promise<{ still_pending: string[]; transient: Error | undefined }> {
  const by_request = new Map(responses.map((r) => [r.id, r]));
  const still_pending: string[] = [];
  let transient: Error | undefined;

  for (const [index, item_id] of pending.entries()) {
    const response = by_request.get(String(index));
    if (response?.status === 200) {
      found.set(item_id, await read_all_pages(client, response.body ?? {}));
      continue;
    }
    const err = to_graph_error(response);
    if (response === undefined || is_transient_error(err)) {
      still_pending.push(item_id);
      transient ??= err;
      continue;
    }
    logger.warn(`Permission capture skipped an item: ${describe_graph_error(err)}`);
  }
  return { still_pending, transient };
}

/** Follows `@odata.nextLink` on the rare item whose permission list spans pages. */
async function read_all_pages(
  client: GraphApiClient,
  first: PermissionPage,
): Promise<DrivePermission[]> {
  const raw: unknown[] = [...(first.value ?? [])];
  let next = first['@odata.nextLink'];
  while (next) {
    const url = next;
    const page = await with_graph_retry(() => client.api(url).get() as Promise<PermissionPage>);
    append_all(raw, page.value ?? []);
    next = page['@odata.nextLink'];
  }
  return sanitize_graph_permissions(raw);
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
