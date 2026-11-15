import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';

/**
 * True for what `with_graph_retry` throws once a call has spent its retry budget: Graph kept
 * failing (`GraphUnavailableError`) or kept throttling (`ThrottledError`).
 */
export function is_exhausted_retry(err: unknown): err is GraphUnavailableError | ThrottledError {
  return err instanceof GraphUnavailableError || err instanceof ThrottledError;
}

/**
 * Rethrows an exhausted retry budget from a best-effort lookup that otherwise swallows its failure.
 *
 * A lookup that may fail without failing the run (a mailbox's purpose, a folder's well-known role,
 * a subsite listing) still has to stop on an outage: swallowing it lets the next call spend a
 * second full budget on the same outage, which is how one backup attempt held a mailbox for about
 * 57 minutes instead of 24 during a Microsoft incident (issue #773). A 403 or a 404 stays the
 * caller's to swallow.
 */
export function rethrow_if_retry_exhausted(err: unknown): void {
  if (is_exhausted_retry(err)) throw err;
}
