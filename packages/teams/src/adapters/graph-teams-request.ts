import type { Client } from '@microsoft/microsoft-graph-client';
import { rethrow_if_teams_access_denied, with_graph_retry } from '@wisecom/atlas-m365-graph';

/** One Graph collection page: its items and the links that continue or finish the read. */
export interface GraphCollectionResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/** Runs one Graph call with throttling retry, naming the Teams permissions a 403 needs. */
export async function graph_teams_call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await with_graph_retry(fn);
  } catch (err) {
    rethrow_if_teams_access_denied(err);
    throw err;
  }
}

/**
 * Follows every `@odata.nextLink` from `start`. Returns all items and the delta link of the last
 * page, which is set only for delta reads.
 */
export async function read_all_pages<T>(
  client: Client,
  start: string,
  extra_headers: Readonly<Record<string, string>> = {},
): Promise<{ items: T[]; delta_link: string | undefined }> {
  const items: T[] = [];
  let next: string | undefined = start;
  let delta_link: string | undefined;
  while (next !== undefined) {
    const url: string = next;
    const page: GraphCollectionResponse<T> = await graph_teams_call(
      () =>
        Object.entries(extra_headers)
          .reduce((request, [name, value]) => request.header(name, value), client.api(url))
          .get() as Promise<GraphCollectionResponse<T>>,
    );
    items.push(...(page.value ?? []));
    delta_link = page['@odata.deltaLink'] ?? delta_link;
    next = page['@odata.nextLink'];
  }
  return { items, delta_link };
}
