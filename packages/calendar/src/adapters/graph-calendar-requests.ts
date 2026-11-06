import type { Client } from '@microsoft/microsoft-graph-client';
import {
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import { is_record } from '@/services/shared/json-record';

export const CALENDARS_READ = 'Calendars.Read';
export const CALENDARS_READ_WRITE = 'Calendars.ReadWrite';

/** Graph reports each event under its immutable id so manifest keys survive calendar moves. */
const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

/** Options for one Graph read. `time_zone` asks Exchange to express start and end in that zone. */
export interface ReadOptions {
  readonly time_zone?: string | undefined;
  readonly beta?: boolean | undefined;
}

/** Base path for a mailbox's calendar endpoints. */
export function mailbox_url(mailbox_id: string): string {
  return `/users/${encodeURIComponent(mailbox_id)}`;
}

/** The Prefer header every calendar request sends: immutable ids, plus an output time zone when asked. */
export function prefer_header(time_zone?: string): string {
  if (time_zone === undefined) return IMMUTABLE_ID_PREFER;
  return `${IMMUTABLE_ID_PREFER}, outlook.timezone="${time_zone.replace(/"/g, '')}"`;
}

/** Runs one Graph call with throttling retries, mapping permission and licence faults to their errors. */
export async function graph_call<T>(permission: string, call: () => Promise<T>): Promise<T> {
  try {
    return await with_graph_retry(call);
  } catch (err) {
    // Licence first: Graph reports MailboxNotEnabledForRESTAPI as a 403 too.
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
  options: ReadOptions = {},
): Promise<T> {
  const base = client.api(url).header('Prefer', prefer_header(options.time_zone));
  const request = options.beta === true ? base.version('beta') : base;
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
  options: ReadOptions = {},
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
      options,
    );
    items.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
  }
  return items;
}
