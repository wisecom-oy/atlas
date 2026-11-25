import type { Client } from '@microsoft/microsoft-graph-client';
import {
  reported_collection_count,
  rethrow_if_teams_access_denied,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import { append_all } from '@wisecom/atlas-core/utils/append-all';

/** One Graph collection page: its items and the links that continue or finish the read. */
export interface GraphCollectionResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/** Asks Graph to return message fields with enum values this client does not know, not drop them. */
export const INCLUDE_UNKNOWN_ENUM_PREFER = 'include-unknown-enum-members';
export const INCLUDE_UNKNOWN_ENUM_HEADERS: Readonly<Record<string, string>> = {
  Prefer: INCLUDE_UNKNOWN_ENUM_PREFER,
};

/** Runs one Graph call with throttling retry, naming the Teams permissions a 403 needs. */
export async function graph_teams_call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await with_graph_retry(fn);
  } catch (err) {
    rethrow_if_teams_access_denied(err);
    throw err;
  }
}

/** Reads one collection page through the Teams retry and permission handling. */
export async function read_collection_page<T>(
  client: Client,
  url: string,
  extra_headers: Readonly<Record<string, string>> = {},
): Promise<GraphCollectionResponse<T>> {
  return graph_teams_call(
    () =>
      Object.entries(extra_headers)
        .reduce((request, [name, value]) => request.header(name, value), client.api(url))
        .get() as Promise<GraphCollectionResponse<T>>,
  );
}

/** Every item of a paged read, with the links and count its pages reported. */
export interface CollectedPages<T> {
  readonly items: T[];
  /** The delta link of the last page, set only for delta reads. */
  readonly delta_link: string | undefined;
  /** The latest `@odata.count`, set only when the read asked for `$count=true`. */
  readonly reported_count: number | undefined;
}

/** Follows every `@odata.nextLink` from `start` and returns every item. */
export async function read_all_pages<T>(
  client: Client,
  start: string,
  extra_headers: Readonly<Record<string, string>> = {},
): Promise<CollectedPages<T>> {
  const items: T[] = [];
  let next: string | undefined = start;
  let delta_link: string | undefined;
  let reported_count: number | undefined;
  while (next !== undefined) {
    const page: GraphCollectionResponse<T> = await read_collection_page<T>(
      client,
      next,
      extra_headers,
    );
    append_all(items, page.value ?? []);
    delta_link = page['@odata.deltaLink'] ?? delta_link;
    reported_count = reported_collection_count(page, reported_count);
    next = page['@odata.nextLink'];
  }
  return { items, delta_link, reported_count };
}
