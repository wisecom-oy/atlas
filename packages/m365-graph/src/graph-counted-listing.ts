import { ListingIncompleteError } from '@wisecom/atlas-types';

/**
 * Asks Graph to report the collection's size on every page of a listing. A plain collection ends
 * with a page that has no `@odata.nextLink`, which looks the same as a page that lost its link, so
 * the count is the only way to tell a finished listing from one cut short (issue #853).
 */
export function with_collection_count(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}$count=true`;
}

/**
 * The `@odata.count` a page reports, or `fallback` when it carries none. Callers keep the latest
 * count across pages, so a unit added or removed while the listing ran is judged by the newest one.
 */
export function reported_collection_count(
  page: unknown,
  fallback: number | undefined,
): number | undefined {
  if (typeof page !== 'object' || page === null) return fallback;
  const count = (page as Record<string, unknown>)['@odata.count'];
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : fallback;
}

/**
 * Throws `ListingIncompleteError` when a listing returned fewer items than Graph counted, or when no
 * page carried a count. More items than counted is accepted: a unit created while the listing ran.
 */
export function assert_listing_complete(
  listing: string,
  listed_count: number,
  reported_count: number | undefined,
): void {
  if (reported_count !== undefined && listed_count >= reported_count) return;
  throw new ListingIncompleteError(listing, listed_count, reported_count);
}
