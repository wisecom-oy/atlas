/** Reads the id a listed item is known by, or undefined when Graph returned it without one. */
export type ListedItemId<T> = (item: T) => string | undefined;

/** Returns the items of one listing that no earlier call has returned. */
export type RepeatedListingFilter<T> = (items: readonly T[]) => T[];

/**
 * Builds a filter that drops an item an earlier listing, or an earlier copy in the same listing,
 * already returned, keeping the first copy. Graph can list a unit more than once, on one page or
 * across pages, and the run would then back it up once per copy (issues #894 and #964).
 *
 * The filter remembers every id it has passed, so one filter shared across a tree walk also drops a
 * unit listed under two parents. `already_listed` seeds ids the walk holds before its first
 * listing. Apply it after the listing's `@odata.count` check, so every copy Graph sent still counts
 * toward that check (issue #853). An item without an id is kept: callers decide what to do with it.
 */
export function create_repeated_listing_filter<T>(
  id_of: ListedItemId<T>,
  already_listed: Iterable<string> = [],
): RepeatedListingFilter<T> {
  const listed_ids = new Set<string>(already_listed);
  return (items) => items.filter((item) => is_first_listing(id_of(item), listed_ids));
}

/** Drops the repeated items of a single listing, keeping the first copy of each id. */
export function drop_repeated_listings<T>(items: readonly T[], id_of: ListedItemId<T>): T[] {
  return create_repeated_listing_filter(id_of)(items);
}

/** Records an id as listed; false when it was listed before. */
function is_first_listing(id: string | undefined, listed_ids: Set<string>): boolean {
  if (id === undefined || id === '') return true;
  if (listed_ids.has(id)) return false;
  listed_ids.add(id);
  return true;
}
