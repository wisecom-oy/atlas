import type { Client } from '@microsoft/microsoft-graph-client';
import {
  assert_listing_complete,
  reported_collection_count,
  with_collection_count,
} from '@wisecom/atlas-m365-graph';
import { fetch_mail_continuation_page } from '@/adapters/graph-mail-delta-sync';
import { append_all } from '@wisecom/atlas-core/utils/append-all';

/** Items requested per page of a collection read. */
const COLLECTION_PAGE_SIZE = 100;

/** Every item of a paged collection, and the latest `@odata.count` any page reported. */
interface CollectedPages<T> {
  readonly items: T[];
  readonly reported_count: number | undefined;
}

/**
 * Follows @odata.nextLink and collects all items.
 * Retry/timeout lives INSIDE the loop (fetch_mail_continuation_page wraps each
 * page in with_graph_retry), so a failed page resumes from the current
 * nextLink. NEVER wrap calls to this in with_graph_retry: the outer 60s
 * timeout races the whole enumeration and restarts it from page 1 --
 * large tenants can never finish (issue #33).
 */
async function read_pages<T>(client: Client, start_url: string): Promise<CollectedPages<T>> {
  const items: T[] = [];
  let reported_count: number | undefined;
  let current_url: string | undefined = start_url;
  while (current_url) {
    const page = await fetch_mail_continuation_page(client, current_url, COLLECTION_PAGE_SIZE);
    if (page.value) append_all(items, page.value as T[]);
    reported_count = reported_collection_count(page, reported_count);
    current_url = page['@odata.nextLink'];
  }
  return { items, reported_count };
}

/** Collects every item of a paged Graph collection. */
export async function collect_all_pages<T>(client: Client, start_url: string): Promise<T[]> {
  return (await read_pages<T>(client, start_url)).items;
}

/**
 * Lists a collection of backup units with `$count=true`. Throws `ListingIncompleteError` when the
 * pages hold fewer items than Graph counted, so a listing that ended early is never taken as the
 * whole collection (issue #853).
 */
export async function collect_counted_listing<T>(
  client: Client,
  start_url: string,
  listing: string,
): Promise<T[]> {
  const pages = await read_pages<T>(client, with_collection_count(start_url));
  assert_listing_complete(listing, pages.items.length, pages.reported_count);
  return pages.items;
}
