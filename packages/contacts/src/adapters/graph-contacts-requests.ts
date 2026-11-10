import type { Client } from '@microsoft/microsoft-graph-client';
import {
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  with_graph_retry,
  type GraphRetryOptions,
} from '@wisecom/atlas-m365-graph';
import { is_record } from '@/services/shared/json-record';

export const CONTACTS_READ = 'Contacts.Read';
export const CONTACTS_READ_WRITE = 'Contacts.ReadWrite';

/** Graph reports each contact under its immutable id so restore keys survive folder moves. */
export const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

/** Base path for a mailbox's contact endpoints. */
export function mailbox_url(mailbox_id: string): string {
  return `/users/${encodeURIComponent(mailbox_id)}`;
}

/**
 * Retry policy for a POST that creates an item, folder or attachment. Sending one again after a
 * 5xx or a timeout can create a second copy, so only a throttle response is retried (issue #624).
 */
export const CREATE_ONCE: GraphRetryOptions = { idempotent: false };

/** Runs one Graph call with throttling retries, mapping permission and licence faults to their errors. */
export async function graph_call<T>(
  permission: string,
  call: (attempt_signal: AbortSignal) => Promise<T>,
  retry: GraphRetryOptions = {},
): Promise<T> {
  try {
    return await with_graph_retry(call, retry);
  } catch (err) {
    // Graph answers an unlicensed mailbox with 403 too, so the licence code must be checked first.
    rethrow_if_mailbox_not_licensed(err);
    rethrow_if_access_denied(err, [permission]);
    throw err;
  }
}

/** Fetches one JSON page or object. The body is untyped until the caller's type is applied. */
export async function get_json<T>(
  client: Client,
  url: string,
  permission: string,
  prefer?: string,
): Promise<T> {
  const request = prefer === undefined ? client.api(url) : client.api(url).header('Prefer', prefer);
  const body: unknown = await graph_call(permission, () => request.get());
  return body as T;
}

/** Reads a string field from a Graph response, failing loudly when Graph omits it. */
export function string_field(body: unknown, field: string): string {
  if (is_record(body)) {
    const value = body[field];
    if (typeof value === 'string') return value;
  }
  throw new Error(`Graph response has no ${field}`);
}

/** Follows `@odata.nextLink` until exhausted, refusing to loop on a repeated link. */
export async function collect_pages<T>(
  client: Client,
  first_url: string,
  permission: string,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let next: string | undefined = first_url;
  while (next !== undefined) {
    if (seen.has(next)) throw new Error('Graph paging did not advance');
    seen.add(next);
    const page: { value?: T[]; '@odata.nextLink'?: string } = await get_json(
      client,
      next,
      permission,
    );
    items.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
  }
  return items;
}

/** Whether a Graph error is an HTTP 404 for the requested object. */
export function is_not_found(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('statusCode' in err)) return false;
  return err.statusCode === 404;
}
