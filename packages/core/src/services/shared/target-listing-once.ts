import { is_active_run_cancelled } from '@/services/shared/graph-request-context';
import { is_run_fatal_error } from '@/services/shared/run-fatal-error';

/** How one restore target's listing ended: what it holds, or the failure that stands for it. */
export type TargetListingOutcome<T> = { readonly listed: T } | { readonly failure: Error };

/** The listing outcome of each restore target in one run, keyed by target id. */
export type TargetListings<T> = Map<string, TargetListingOutcome<T>>;

/**
 * Lists what a restore target already holds once per run and reuses the outcome for every entry
 * that targets it, a failure included (issue #886).
 *
 * A listing that failed after its retries is not attempted again in the same run: each further
 * entry for that target fails at once with the same error, whose message names the listing. Caching
 * only success let every entry list the target again with a fresh retry budget, so one calendar or
 * contact folder in a sustained outage cost one full budget per entry.
 *
 * A failure is never read as an empty target, which would restore duplicates of what is already
 * there. A cancellation and a run-fatal error (`AuthError`, `MailboxNotLicensedError`) are
 * rethrown unchanged and not remembered: the caller ends the run on either.
 */
export async function list_target_once<T>(
  listings: TargetListings<T>,
  target_id: string,
  what: string,
  list: () => Promise<T>,
): Promise<T> {
  const known = listings.get(target_id);
  if (known !== undefined) {
    if ('failure' in known) throw known.failure;
    return known.listed;
  }
  try {
    const listed = await list();
    listings.set(target_id, { listed });
    return listed;
  } catch (err) {
    if (is_active_run_cancelled() || is_run_fatal_error(err)) throw err;
    const failure = listing_failure(what, err);
    listings.set(target_id, { failure });
    throw failure;
  }
}

/** The error every entry of a target whose listing failed is reported with. */
function listing_failure(what: string, err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err);
  return new Error(`could not list ${what}: ${reason}`, { cause: err });
}
