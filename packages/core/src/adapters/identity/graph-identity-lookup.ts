import type {
  ResolvedUserIdentity,
  UserIdentityResolver,
  UserLookupPurpose,
} from '@wisecom/atlas-types';
import {
  get_active_abort_signal,
  run_with_abort_signal,
} from '@/services/shared/graph-request-context';
import { is_graph_outage } from '@/services/shared/graph-outage-latch';

/**
 * How long a lookup for a command that only reads stored backups waits on Microsoft Graph before
 * the identity registry answers instead. Long enough for a healthy lookup and its `404`
 * confirmation reads (about 6 s), short enough that an operator checking backups during an
 * outage is not held for the 24-minute retry budget (issue #887).
 */
export const STORED_BACKUPS_GRAPH_WAIT_MS = 15_000;

/** Graph's answer to a lookup, or the failure that took its place. */
export type GraphLookupOutcome = { identity: ResolvedUserIdentity } | { error: unknown };

/** The abort reason of a lookup cut short by {@link STORED_BACKUPS_GRAPH_WAIT_MS}. */
export class GraphLookupWaitElapsedError extends Error {
  constructor(wait_ms: number) {
    super(`Microsoft Graph did not answer within ${Math.round(wait_ms / 1000)} s`);
    this.name = 'GraphLookupWaitElapsedError';
  }
}

/**
 * Asks Graph for `email`, waiting at most `wait_ms` when given. A failure comes back as `error`
 * for the caller to judge, except a cancellation of the run around the lookup, which is rethrown:
 * a stopped command must not continue on a registry entry.
 */
export async function ask_graph_for_identity(
  graph: UserIdentityResolver,
  tenant_id: string,
  email: string,
  wait_ms?: number,
): Promise<GraphLookupOutcome> {
  const run_signal = get_active_abort_signal();
  try {
    const lookup = (): Promise<ResolvedUserIdentity> => graph.resolve_user(tenant_id, email);
    const identity =
      wait_ms === undefined ? await lookup() : await within_wait(run_signal, wait_ms, lookup);
    return { identity };
  } catch (err) {
    if (run_signal?.aborted === true) throw err;
    return { error: err };
  }
}

/**
 * Runs `lookup` with an abort signal that also fires after `wait_ms`, so a Graph retry wait or a
 * request in flight ends there. The lookup is raced against the signal as well, so a step that
 * does not listen for it cannot hold the caller past the wait.
 */
async function within_wait<T>(
  run_signal: AbortSignal | undefined,
  wait_ms: number,
  lookup: () => Promise<T>,
): Promise<T> {
  const elapsed = new AbortController();
  const timer = setTimeout(() => elapsed.abort(new GraphLookupWaitElapsedError(wait_ms)), wait_ms);
  const signal = run_signal ? AbortSignal.any([run_signal, elapsed.signal]) : elapsed.signal;
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const on_abort = (): void => reject(signal.reason);
  signal.addEventListener('abort', on_abort, { once: true });
  try {
    return await Promise.race([run_with_abort_signal(signal, lookup), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', on_abort);
  }
}

/**
 * Whether a registry entry may stand in for a failed Graph lookup.
 *
 * For a command that works on live data, an exhausted retry budget says Microsoft Graph is down,
 * not that this user is unanswerable, and the command's next Graph call would spend a second
 * budget on the same outage while it holds the owner's lease (issue #882). Any other failure, such
 * as a `404` for a deleted user, still falls back. A command that only reads stored backups needs
 * nothing more from Graph, so every failure falls back.
 */
export function registry_may_answer(error: unknown, purpose: UserLookupPurpose): boolean {
  return purpose === 'stored_backups' || !is_graph_outage(error);
}

/** One line naming why Graph's answer was not used, led by the HTTP status when there is one. */
export function describe_lookup_failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as Record<string, unknown> | null)?.statusCode;
  return typeof status === 'number' ? `HTTP ${status}: ${message}` : message;
}
