import { UnreadableObjectsError, type ReadableSnapshotSummaries } from '@wisecom/atlas-types';

/**
 * Returns the summaries of a listing, raising when a rowless manifest could not be read: the
 * totals would silently leave that snapshot out, as `list_snapshots_by_owner` refused to do.
 */
export function require_every_summary<T>(
  listing: ReadableSnapshotSummaries<T>,
  workload: string,
): T[] {
  if (listing.unreadable_keys.length === 0) return listing.summaries;
  throw new UnreadableObjectsError(
    `${listing.unreadable_keys.length} ${workload} manifest(s) could not be read`,
    listing.unreadable_keys,
  );
}
