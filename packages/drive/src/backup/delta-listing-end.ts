/** The paging links one Graph delta page can carry. */
export interface DeltaPageLinks {
  readonly '@odata.nextLink'?: string | undefined;
  readonly '@odata.deltaLink'?: string | undefined;
}

/** What a delta result needs to show that its listing reached the end. */
interface DeltaListingResult {
  readonly delta_link: string;
}

/** The failure for a listing that stopped before Graph handed out its delta link. */
function incomplete_listing_error(label: string): Error {
  return new Error(
    `Graph ended the delta listing of ${label} without a delta link, so the listing is ` +
      'incomplete and its changes are read again next run',
  );
}

/**
 * The delta link on the page a listing ends with, that is, the page without `@odata.nextLink`.
 *
 * Graph's contract is that this page carries `@odata.deltaLink`. A page with neither link means the
 * listing was cut short: the items that arrived are not the drive's full change set, and on a full
 * read their absences would be taken for deletions (issue #852). So that page throws instead.
 */
export function final_delta_link(page: DeltaPageLinks, label: string): string {
  const delta_link = page['@odata.deltaLink'];
  if (!delta_link) throw incomplete_listing_error(label);
  return delta_link;
}

/**
 * Throws when a connector's delta result carries no delta link. The pagers already refuse such a
 * listing; this keeps any connector that returns one from being processed as a finished listing,
 * which would advance nothing and, on a full read, tombstone files that still exist.
 */
export function assert_delta_listing_complete(delta: DeltaListingResult, label: string): void {
  if (!delta.delta_link) throw incomplete_listing_error(label);
}
